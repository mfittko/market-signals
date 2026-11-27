package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/mfittko/market-signals/platform/internal/queue"
)

func TestClaudeArgsMatchTheGoldenNodeFlags(t *testing.T) {
	raw, err := os.ReadFile("testdata/claude-args.golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var golden struct{ WithModel, WithoutModel []string }
	if err := json.Unmarshal(raw, &golden); err != nil {
		t.Fatal(err)
	}
	if got := claudeArgs("SYS", "M", "PROMPT"); !reflect.DeepEqual(got, golden.WithModel) {
		t.Fatalf("with model:\n got %q\nwant %q", got, golden.WithModel)
	}
	if got := claudeArgs("SYS", "", "PROMPT"); !reflect.DeepEqual(got, golden.WithoutModel) {
		t.Fatalf("without model:\n got %q\nwant %q", got, golden.WithoutModel)
	}
}

func TestFindClaudeOnlyReturnsAnExecutableOnTheExtendedPath(t *testing.T) {
	old := claudeDirs
	t.Cleanup(func() { claudeDirs = old })
	claudeDirs = []string{t.TempDir()} // keeps a real install out of the test
	home, path := t.TempDir(), t.TempDir()
	if got := FindClaude(home, path); got != "" {
		t.Fatalf("no binary anywhere: got %q", got)
	}
	if err := os.WriteFile(filepath.Join(path, "claude"), []byte("#!/bin/sh\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := FindClaude(home, path); got != "" {
		t.Fatalf("a file that is not executable must not count: got %q", got)
	}
	bin := filepath.Join(home, ".local/bin/claude")
	if err := os.MkdirAll(filepath.Dir(bin), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bin, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := FindClaude(home, path); got != bin {
		t.Fatalf("got %q, want %q", got, bin)
	}
}

// stubClaude writes an executable claude stub into a temp dir. %D in body is that dir.
func stubClaude(t *testing.T, body string) (bin, dir string) {
	t.Helper()
	dir = t.TempDir()
	bin = filepath.Join(dir, "claude")
	script := "#!/bin/sh\necho x >> '" + dir + "/starts'\n" + strings.ReplaceAll(body, "%D", dir) + "\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return bin, dir
}

// hang never answers and keeps a background child that writes its pid.
const hang = "sleep 30 &\necho $! > '%D/child'\nwait"

func starts(t *testing.T, dir string) int {
	raw, _ := os.ReadFile(filepath.Join(dir, "starts"))
	return strings.Count(string(raw), "x")
}

func waitFile(t *testing.T, p string) string {
	t.Helper()
	for end := time.Now().Add(5 * time.Second); time.Now().Before(end); time.Sleep(10 * time.Millisecond) {
		if raw, err := os.ReadFile(p); err == nil && strings.HasSuffix(string(raw), "\n") {
			return strings.TrimSpace(string(raw))
		}
	}
	t.Fatalf("%s never appeared", p)
	return ""
}

// assertGone waits up to 2 s for the process to disappear.
func assertGone(t *testing.T, dir string) {
	t.Helper()
	pid, err := strconv.Atoi(waitFile(t, filepath.Join(dir, "child")))
	if err != nil {
		t.Fatal(err)
	}
	for end := time.Now().Add(2 * time.Second); time.Now().Before(end); time.Sleep(20 * time.Millisecond) {
		if errors.Is(syscall.Kill(pid, 0), syscall.ESRCH) {
			return
		}
	}
	_ = syscall.Kill(pid, syscall.SIGKILL)
	t.Fatalf("child %d still runs", pid)
}

type spendLog struct {
	mu    sync.Mutex
	calls []SpendCall
	err   error
}

func (s *spendLog) record(_ context.Context, c SpendCall) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, c)
	return s.err
}

func chatOnce(c *ClaudeCode, ctx context.Context) error {
	_, _, err := c.Chat(ctx, map[string]any{"model": "m", "messages": []map[string]any{{"role": "system", "content": "s"}, {"role": "user", "content": "u"}}})
	return err
}

func TestClaudeCodeDeadlineKillsTheGroupWithReasonTimeout(t *testing.T) {
	bin, dir := stubClaude(t, hang)
	c := NewClaudeCode(bin, (&spendLog{}).record, nil)
	c.Deadline = 500 * time.Millisecond
	t0 := time.Now()
	err := chatOnce(c, context.Background())
	if !hasReason(err, ReasonTimeout) {
		t.Fatalf("got %v, want a timeout", err)
	}
	if d := time.Since(t0); d > c.Deadline+2*time.Second {
		t.Fatalf("took %v", d)
	}
	assertGone(t, dir)
}

func TestClaudeCodeCallerCancelKillsTheGroupWithin2s(t *testing.T) {
	bin, dir := stubClaude(t, hang)
	c := NewClaudeCode(bin, (&spendLog{}).record, nil)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- chatOnce(c, ctx) }()
	waitFile(t, filepath.Join(dir, "child"))
	cancel()
	select {
	case err := <-done:
		if err == nil || hasReason(err, ReasonTimeout) {
			t.Fatalf("got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancel did not end the call within 2 s")
	}
	assertGone(t, dir)
	// a caller cancel does not count toward the breaker
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.fails != 0 {
		t.Fatalf("fails %d", c.fails)
	}
}

func claudeInput(runID int64) Input {
	return Input{
		Claim: &queue.Claim{Run: queue.Run{ID: runID}, Agent: queue.Agent{Model: "m", Budgets: queue.Budgets{}.WithDefaults()},
			Snapshot: queue.Snapshot{Payload: json.RawMessage(`{"instrument":"WTICO/USD","close":100}`)}, Notes: json.RawMessage(`[]`)},
		Emit: func(string, any) {},
	}
}

func TestClaudeCodeRunStartsNoRoundAfterACancel(t *testing.T) {
	bin, dir := stubClaude(t, hang)
	l := &LLM{GW: NewClaudeCode(bin, (&spendLog{}).record, nil), RuntimeName: ClaudeCodeProvider}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := l.Run(ctx, claudeInput(1)); done <- err }()
	waitFile(t, filepath.Join(dir, "child"))
	cancel()
	if err := <-done; err == nil {
		t.Fatal("a cancelled run must return an error")
	}
	if n := starts(t, dir); n != 1 {
		t.Fatalf("the stub started %d times", n)
	}
	assertGone(t, dir)
}

func TestClaudeCodeBreakerOpensAfter5FailuresWithoutStartingTheBinary(t *testing.T) {
	failBin, failDir := stubClaude(t, "exit 1")
	junkBin, junkDir := stubClaude(t, "echo not-json")
	now := time.Now()
	c := NewClaudeCode(failBin, (&spendLog{}).record, nil)
	c.Now = func() time.Time { return now }
	for i := range 5 {
		if i == 3 {
			c.Bin = junkBin // unparseable output counts as a failure too
		}
		if err := chatOnce(c, context.Background()); !hasReason(err, ReasonProvider) {
			t.Fatalf("call %d: %v", i, err)
		}
	}
	if err := chatOnce(c, context.Background()); !hasReason(err, ReasonBreakerOpen) {
		t.Fatalf("got %v, want breaker_open", err)
	}
	if n := starts(t, failDir) + starts(t, junkDir); n != 5 {
		t.Fatalf("the binary started %d times", n)
	}
	// after 60 s one call goes through again; its failure reopens the breaker
	now = now.Add(breakerOpen + time.Second)
	if err := chatOnce(c, context.Background()); !hasReason(err, ReasonProvider) {
		t.Fatalf("got %v", err)
	}
	if err := chatOnce(c, context.Background()); !hasReason(err, ReasonBreakerOpen) {
		t.Fatalf("got %v, want breaker_open", err)
	}
}

const answer = `printf '%s\n' "$@" > '%D/args'
pwd > '%D/cwd'
echo '{"type":"result","is_error":false,"result":" {\"action\":\"hold\",\"reasoning\":\"stub\"} ","usage":{"input_tokens":3,"cache_creation_input_tokens":2,"cache_read_input_tokens":1,"output_tokens":4}}'`

func TestClaudeCodeRunParsesTheProposalAndRecordsAFreeRow(t *testing.T) {
	bin, dir := stubClaude(t, answer)
	rec := &spendLog{err: errors.New("ledger down")} // a failed record keeps the reply
	l := &LLM{GW: NewClaudeCode(bin, rec.record, nil), RuntimeName: ClaudeCodeProvider}
	if l.Name() != "claude-code" {
		t.Fatalf("name %q", l.Name())
	}
	out, err := l.Run(context.Background(), claudeInput(42))
	if err != nil {
		t.Fatal(err)
	}
	if out.Proposal.Action != "hold" || out.Proposal.Reasoning != "stub" || out.StopReason != "completed" || out.Usage["llmCalls"] != 1 {
		t.Fatalf("%+v %+v", out.Proposal, out.Usage)
	}
	want := SpendCall{CallSite: "agent", Provider: "claude-code", Model: "m", PromptTokens: 6, CompletionTokens: 4, RunID: 42}
	if len(rec.calls) != 1 || rec.calls[0] != want {
		t.Fatalf("got %+v, want one %+v", rec.calls, want)
	}
	args := waitFile(t, filepath.Join(dir, "args"))
	if !strings.Contains(args, "No tools are available in this run. Use only the snapshot below.") || strings.Contains(args, "get_snapshot") {
		t.Fatalf("prompt must state there are no tools and drop the get_snapshot hint:\n%s", args)
	}
	cwd := waitFile(t, filepath.Join(dir, "cwd"))
	if _, err := os.Stat(cwd); !os.IsNotExist(err) || strings.HasPrefix(cwd, dir) {
		t.Fatalf("the call must run in a fresh temp dir that is removed afterwards: %q %v", cwd, err)
	}
}
