package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/mfittko/market-signals/platform/internal/spend"
)

// ClaudeCodeProvider is the runtime name, the spend provider and the ModelError provider of claude-code calls.
const ClaudeCodeProvider = spend.ClaudeCode

const (
	claudeWaitDelay = 2 * time.Second
	claudeMaxOutput = 8 << 20
)

// claudeDirs are searched before PATH, like the Node engine does; ~/.local/bin follows them.
var claudeDirs = []string{"/opt/homebrew/bin", "/usr/local/bin"}

// claudeArgs is the only sandbox flag list: no tools, no MCP servers, no settings, hooks, skills or session files.
func claudeArgs(system, model, prompt string) []string {
	args := []string{"-p", "--no-session-persistence", "--tools", "", "--strict-mcp-config", "--setting-sources", "",
		"--disable-slash-commands", "--output-format", "json", "--system-prompt", system}
	if model != "" {
		args = append(args, "--model", model)
	}
	return append(args, prompt)
}

func claudePATH(home, path string) string {
	dirs := append([]string{}, claudeDirs...)
	if home != "" { // an empty home would make ".local/bin" relative to the cwd
		dirs = append(dirs, filepath.Join(home, ".local/bin"))
	}
	return strings.Join(append(dirs, path), string(os.PathListSeparator))
}

// FindClaude returns the claude binary on the extended PATH, or "" when there is none.
func FindClaude(home, path string) string {
	for _, d := range filepath.SplitList(claudePATH(home, path)) {
		if !filepath.IsAbs(d) { // a relative entry resolves against the cwd
			continue
		}
		p := filepath.Join(d, "claude")
		if fi, err := os.Stat(p); err == nil && fi.Mode().IsRegular() && fi.Mode()&0o111 != 0 {
			return p
		}
	}
	return ""
}

// ClaudeCode runs the local Claude Code CLI as a tool-less chat backend. It uses the operator's own login, so
// no key is stored. Each call runs in a fresh temp directory and its own process group; the deadline and a
// caller cancel kill the whole group.
type ClaudeCode struct {
	Bin      string
	Record   func(ctx context.Context, c SpendCall) error
	Deadline time.Duration
	Now      func() time.Time
	Log      *slog.Logger

	mu        sync.Mutex
	fails     int
	openUntil time.Time
}

func NewClaudeCode(bin string, record func(context.Context, SpendCall) error, log *slog.Logger) *ClaudeCode {
	if log == nil {
		log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return &ClaudeCode{Bin: bin, Record: record, Deadline: defaultDeadline, Now: time.Now, Log: log}
}

// capped keeps the first n bytes and drops the rest, so a runaway child cannot fill memory.
type capped struct {
	b []byte
	n int
}

func (c *capped) Write(p []byte) (int, error) {
	c.b = append(c.b, p[:min(len(p), max(c.n-len(c.b), 0))]...)
	return len(p), nil
}

// capture returns a pipe end for the child and a func that closes it and returns the first n bytes read.
// The child gets an *os.File, so Wait returns when the leader exits even if a group child still holds the pipe.
func capture(n int) (*os.File, func() []byte, error) {
	r, w, err := os.Pipe()
	if err != nil {
		return nil, nil, err
	}
	c, done := &capped{n: n}, make(chan struct{})
	go func() { _, _ = io.Copy(c, r); close(done) }()
	return w, func() []byte {
		_ = w.Close()
		select {
		case <-done:
		case <-time.After(claudeWaitDelay): // a process outside the group still holds the pipe
		}
		_ = r.Close()
		<-done
		return c.b
	}, nil
}

// Chat sends the system message and the joined user messages as one CLI call. The reply has no tool calls.
func (c *ClaudeCode) Chat(ctx context.Context, req map[string]any) (map[string]any, usage, error) {
	model, _ := req["model"].(string)
	u := usage{Model: model, Provider: ClaudeCodeProvider}
	// shortcut: no single-probe half-open; up to worker concurrency calls retry after the window, add a probe if concurrency grows.
	c.mu.Lock()
	open := c.fails >= breakerFailures && c.Now().Before(c.openUntil)
	c.mu.Unlock()
	if open {
		return nil, u, &ModelError{Provider: ClaudeCodeProvider, Reason: ReasonBreakerOpen}
	}
	system, prompt := splitMessages(req)
	msg, err := c.run(ctx, system, model, prompt, &u)
	// a caller cancel says nothing about the binary, so it does not move the breaker
	if err == nil || !errors.Is(ctx.Err(), context.Canceled) {
		c.mu.Lock()
		if err == nil {
			c.fails = 0
		} else if c.fails++; c.fails >= breakerFailures {
			c.openUntil = c.Now().Add(breakerOpen)
		}
		c.mu.Unlock()
	}
	return msg, u, err
}

func (c *ClaudeCode) run(ctx context.Context, system, model, prompt string, u *usage) (map[string]any, error) {
	callCtx, cancel := context.WithTimeout(ctx, c.Deadline)
	defer cancel()
	dir, err := os.MkdirTemp("", "claude-code-")
	if err != nil {
		return nil, &ModelError{Provider: ClaudeCodeProvider, Reason: ReasonProvider, Err: err}
	}
	defer os.RemoveAll(dir)
	home, _ := os.UserHomeDir()
	cmd := exec.CommandContext(callCtx, c.Bin, claudeArgs(system, model, prompt)...)
	cmd.Dir = dir // keeps project CLAUDE.md and memory out of the prompt
	cmd.Env = claudeEnv(os.Environ(), home, dir)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = claudeWaitDelay
	stdoutW, readOut, err := capture(claudeMaxOutput)
	if err != nil {
		return nil, &ModelError{Provider: ClaudeCodeProvider, Reason: ReasonProvider, Err: err}
	}
	stderrW, readErr, err := capture(4 << 10)
	if err != nil {
		readOut()
		return nil, &ModelError{Provider: ClaudeCodeProvider, Reason: ReasonProvider, Err: err}
	}
	cmd.Stdout, cmd.Stderr = stdoutW, stderrW
	err = cmd.Run()
	// shortcut: the group kill runs after the leader is reaped, so a pid reused as a group leader in that window
	// would be killed; keep the group owned across the reap if the worker shares a host with many short-lived processes.
	if cmd.Process != nil { // a leftover group child must not outlive the call
		if kerr := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); kerr != nil && !errors.Is(kerr, syscall.ESRCH) {
			c.Log.Warn("claude-code group kill failed", "err", kerr)
		}
	}
	out, stderr := readOut(), readErr()
	var body struct {
		IsError bool    `json:"is_error"`
		Result  *string `json:"result"`
		Usage   *struct {
			Input         float64 `json:"input_tokens"`
			CacheCreation float64 `json:"cache_creation_input_tokens"`
			CacheRead     float64 `json:"cache_read_input_tokens"`
			Output        float64 `json:"output_tokens"`
		} `json:"usage"`
	}
	if err == nil {
		if jerr := json.Unmarshal(out, &body); jerr != nil || body.IsError || body.Result == nil {
			err = errors.New("claude-code returned no result")
		}
	}
	if body.Usage != nil {
		u.PromptTokens = body.Usage.Input + body.Usage.CacheCreation + body.Usage.CacheRead
		u.CompletionTokens = body.Usage.Output
	}
	if cmd.Process != nil { // a binary that never started costs nothing and writes no row
		c.spend(ctx, *u, body.Usage == nil)
	}
	if err != nil {
		reason := ReasonProvider
		if errors.Is(callCtx.Err(), context.DeadlineExceeded) {
			reason = ReasonTimeout
		}
		// stderr may echo the prompt, so it goes only to the log
		c.Log.Warn("claude-code call failed", "reason", reason, "err", err, "stderr", clip(strings.TrimSpace(string(stderr)), 200))
		return nil, &ModelError{Provider: ClaudeCodeProvider, Reason: reason, Err: err}
	}
	return map[string]any{"role": "assistant", "content": strings.TrimSpace(*body.Result)}, nil
}

// dropClaudeEnv removes the child variables that would bill the call: every ANTHROPIC_ variable (API key, auth
// token, base URL) and the Bedrock and Vertex switches. Without them the CLI uses the operator subscription, so
// the $0 rows stay true. It also removes the worker's PWD and OLDPWD, which name the worker cwd, not the temp dir.
func dropClaudeEnv(kv string) bool {
	return strings.HasPrefix(kv, "ANTHROPIC_") || strings.HasPrefix(kv, "CLAUDE_CODE_USE_BEDROCK=") ||
		strings.HasPrefix(kv, "CLAUDE_CODE_USE_VERTEX=") || strings.HasPrefix(kv, "PWD=") || strings.HasPrefix(kv, "OLDPWD=")
}

// claudeEnv is the child environment. os/exec sets PWD to cmd.Dir only when cmd.Env is nil, so PWD is set here.
func claudeEnv(environ []string, home, dir string) []string {
	env := slices.DeleteFunc(slices.Clone(environ), dropClaudeEnv)
	return append(env, "PATH="+claudePATH(home, os.Getenv("PATH")), "PWD="+dir)
}

// spend records one $0 row per started call. A failed record is logged and the reply is kept: the call costs nothing.
func (c *ClaudeCode) spend(ctx context.Context, u usage, estimated bool) {
	if c.Record == nil {
		return
	}
	site, runID := CallFrom(ctx)
	call := SpendCall{CallSite: site, Provider: ClaudeCodeProvider, Model: orStr(u.Model, ClaudeCodeProvider),
		PromptTokens: int64(u.PromptTokens), CompletionTokens: int64(u.CompletionTokens), Estimated: estimated, RunID: runID}
	rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), recordTimeout)
	defer cancel()
	if err := c.Record(rctx, call); err != nil {
		c.Log.Warn("claude-code spend unrecorded; the reply is kept", "callSite", site, "err", err)
	}
}

// splitMessages returns the system message and the other messages' text, joined.
func splitMessages(req map[string]any) (string, string) {
	var system string
	var parts []string
	msgs, _ := req["messages"].([]map[string]any)
	for _, m := range msgs {
		if m["role"] == "system" {
			system = contentOf(m)
		} else {
			parts = append(parts, contentOf(m))
		}
	}
	return system, strings.Join(parts, "\n\n")
}
