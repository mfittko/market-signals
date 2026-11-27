package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
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
	// a relative PATH entry resolves against the cwd and must be skipped
	rel := t.TempDir()
	if err := os.WriteFile(filepath.Join(rel, "claude"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Chdir(rel)
	if got := FindClaude(home, "."+string(os.PathListSeparator)+path); got != "" {
		t.Fatalf("a relative PATH entry must not count: got %q", got)
	}
	if got := FindClaude("", path); got != "" {
		t.Fatalf("an empty home must not add a relative .local/bin: got %q", got)
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

func starts(dir string) int {
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
	// the pid is written first, so a slow start under -race still leaves it before the deadline
	bin, dir := stubClaude(t, "sleep 30 & echo $! > '%D/child'; wait")
	c := NewClaudeCode(bin, (&spendLog{}).record, nil)
	c.Deadline = time.Second
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
	if n := starts(dir); n != 1 {
		t.Fatalf("the stub started %d times", n)
	}
	assertGone(t, dir)
}

func TestClaudeCodeBreakerOpensAfter5FailuresWithoutStartingTheBinary(t *testing.T) {
	failBin, failDir := stubClaude(t, "exit 1")
	junkBin, junkDir := stubClaude(t, "echo not-json")
	now := time.Now()
	hangBin, _ := stubClaude(t, hang)
	c := NewClaudeCode(hangBin, (&spendLog{}).record, nil)
	c.Now = func() time.Time { return now }
	// a deadline counts as a failure
	c.Deadline = 300 * time.Millisecond
	if err := chatOnce(c, context.Background()); !hasReason(err, ReasonTimeout) {
		t.Fatalf("got %v, want a timeout", err)
	}
	c.mu.Lock()
	fails := c.fails
	c.mu.Unlock()
	if fails != 1 {
		t.Fatalf("a deadline must count: fails %d", fails)
	}
	c.Bin, c.Deadline = failBin, defaultDeadline
	for i := 1; i < 5; i++ {
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
	// the hang stub may die at the deadline before it logs its start, so only the other 4 are counted
	if n := starts(failDir) + starts(junkDir); n != 4 {
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

func TestClaudeCodeValidReplyKillsALeftoverChildWithoutWaitDelay(t *testing.T) {
	bin, dir := stubClaude(t, `sleep 30 &
echo $! > '%D/child'
echo '{"is_error":false,"result":"ok"}'`)
	c := NewClaudeCode(bin, (&spendLog{}).record, nil)
	t0 := time.Now()
	msg, _, err := c.Chat(context.Background(), map[string]any{"model": "m", "messages": []map[string]any{{"role": "user", "content": "u"}}})
	if err != nil || msg["content"] != "ok" {
		t.Fatalf("got %v %v", msg, err)
	}
	if d := time.Since(t0); d >= claudeWaitDelay {
		t.Fatalf("the leftover child held the call for %v", d)
	}
	assertGone(t, dir)
}

func TestClaudeCodeChildGetsNoAnthropicKeyOrBaseURL(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "fake-key")
	t.Setenv("ANTHROPIC_BASE_URL", "http://fake.invalid")
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "fake-token")
	t.Setenv("CLAUDE_CODE_USE_BEDROCK", "1")
	bin, dir := stubClaude(t, `echo "${ANTHROPIC_API_KEY-unset} ${ANTHROPIC_BASE_URL-unset} ${ANTHROPIC_AUTH_TOKEN-unset} ${CLAUDE_CODE_USE_BEDROCK-unset}" > '%D/env'
echo "$PWD" > '%D/pwd'
pwd > '%D/cwd'
echo '{"is_error":false,"result":"ok"}'`)
	if err := chatOnce(NewClaudeCode(bin, nil, nil), context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := waitFile(t, filepath.Join(dir, "env")); got != "unset unset unset unset" {
		t.Fatalf("the child saw %q", got)
	}
	if pwd, cwd := waitFile(t, filepath.Join(dir, "pwd")), waitFile(t, filepath.Join(dir, "cwd")); pwd != cwd {
		t.Fatalf("the child PWD %q is not its temp dir %q", pwd, cwd)
	}
}

func TestDropClaudeEnvKeepsOnlyUnbilledVariables(t *testing.T) {
	for kv, drop := range map[string]bool{
		"PATH=/usr/bin":                      false,
		"HOME=/Users/x":                      false,
		"CLAUDE_CONFIG_DIR=/Users/x/.claude": false,
		"ANTHROPIC_API_KEY=k":                true,
		"ANTHROPIC_BASE_URL=u":               true,
		"ANTHROPIC_AUTH_TOKEN=t":             true,
		"CLAUDE_CODE_USE_BEDROCK=1":          true,
		"CLAUDE_CODE_USE_VERTEX=1":           true,
		"PWD=/worker":                        true,
		"OLDPWD=/worker":                     true,
	} {
		if got := dropClaudeEnv(kv); got != drop {
			t.Errorf("dropClaudeEnv(%q) = %v, want %v", kv, got, drop)
		}
	}
}

func TestClaudeEnvSetsPWDToTheTempDir(t *testing.T) {
	env := claudeEnv([]string{"HOME=/h", "PWD=/worker", "OLDPWD=/old"}, "/h", "/tmp/claude-code-1")
	var pwds []string
	for _, kv := range env {
		if v, ok := strings.CutPrefix(kv, "PWD="); ok {
			pwds = append(pwds, v)
		}
		if strings.HasPrefix(kv, "OLDPWD=") {
			t.Fatalf("OLDPWD kept: %q", kv)
		}
	}
	if !reflect.DeepEqual(pwds, []string{"/tmp/claude-code-1"}) {
		t.Fatalf("PWD entries %q", pwds)
	}
}

func TestClaudeCodeIsErrorReplyCountsAsAFailure(t *testing.T) {
	bin, _ := stubClaude(t, `echo '{"is_error":true,"result":"Invalid API key"}'`)
	rec := &spendLog{}
	c := NewClaudeCode(bin, rec.record, nil)
	msg, _, err := c.Chat(context.Background(), map[string]any{"model": "m", "messages": []map[string]any{{"role": "user", "content": "u"}}})
	if !hasReason(err, ReasonProvider) || msg != nil {
		t.Fatalf("got %v %v, want a provider error and no reply", msg, err)
	}
	// a started call that fails still writes one row, estimated with 0 tokens because the CLI sent no usage
	want := SpendCall{CallSite: "unknown", Provider: "claude-code", Model: "m", Estimated: true}
	if len(rec.calls) != 1 || rec.calls[0] != want {
		t.Fatalf("got %+v, want one %+v", rec.calls, want)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.fails != 1 {
		t.Fatalf("fails %d", c.fails)
	}
}

func TestClaudeCodeBinaryThatNeverStartsWritesNoRow(t *testing.T) {
	rec := &spendLog{}
	c := NewClaudeCode(filepath.Join(t.TempDir(), "missing"), rec.record, nil)
	if err := chatOnce(c, context.Background()); !hasReason(err, ReasonProvider) {
		t.Fatalf("got %v, want a provider error", err)
	}
	if len(rec.calls) != 0 {
		t.Fatalf("got %+v, want no row", rec.calls)
	}
}

func TestCappedKeepsTheFirstNBytesAndReportsEveryWrite(t *testing.T) {
	c := &capped{n: 5}
	for _, p := range []string{"abc", "def", "ghi"} {
		if n, err := c.Write([]byte(p)); n != len(p) || err != nil {
			t.Fatalf("Write(%q) = %d, %v", p, n, err)
		}
	}
	if string(c.b) != "abcde" {
		t.Fatalf("kept %q", c.b)
	}
}

func TestClaudeCodeDrainsBothPipesAgainstOneDeadline(t *testing.T) {
	if _, err := exec.LookPath("perl"); err != nil {
		t.Skip("perl moves the child out of the group")
	}
	// the child leaves the process group, so the group kill misses it and it keeps stdout and stderr open
	bin, dir := stubClaude(t, `perl -e 'setpgrp(0,0); sleep 30' &
echo $! > '%D/child'
wait`)
	c := NewClaudeCode(bin, (&spendLog{}).record, nil)
	c.Deadline = time.Second
	t.Cleanup(func() {
		if pid, err := strconv.Atoi(waitFile(t, filepath.Join(dir, "child"))); err == nil {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	})
	t0 := time.Now()
	if err := chatOnce(c, context.Background()); !hasReason(err, ReasonTimeout) {
		t.Fatalf("got %v, want a timeout", err)
	}
	// sequential drains would take the deadline plus two wait delays
	if d := time.Since(t0); d > c.Deadline+claudeWaitDelay+time.Second {
		t.Fatalf("took %v", d)
	}
}

func TestClaudeCodeSuccessResetsTheBreakerCount(t *testing.T) {
	failBin, failDir := stubClaude(t, "exit 1")
	okBin, _ := stubClaude(t, `echo '{"is_error":false,"result":"ok"}'`)
	c := NewClaudeCode(failBin, (&spendLog{}).record, nil)
	for i := 0; i < 4; i++ {
		if err := chatOnce(c, context.Background()); !hasReason(err, ReasonProvider) {
			t.Fatalf("call %d: %v", i, err)
		}
	}
	c.Bin = okBin
	if err := chatOnce(c, context.Background()); err != nil {
		t.Fatal(err)
	}
	c.Bin = failBin
	// 4 failures, 1 success, 1 failure: the count restarted, so the breaker stays closed and the binary starts.
	// Without the reset the 6th call is the 5th failure and opens the breaker for the 7th.
	for i := 0; i < 2; i++ {
		if err := chatOnce(c, context.Background()); !hasReason(err, ReasonProvider) {
			t.Fatalf("call %d after the success: got %v, want a provider error", i+1, err)
		}
	}
	if n := starts(failDir); n != 6 {
		t.Fatalf("the failing binary started %d times", n)
	}
}

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
