package queue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mfittko/market-signals/platform/internal/db"
	"github.com/mfittko/market-signals/platform/internal/domain"
	"github.com/mfittko/market-signals/platform/internal/testutil"
	"github.com/mfittko/market-signals/platform/migrations"
)

var testPool *pgxpool.Pool

func TestMain(m *testing.M) {
	url := os.Getenv("MS_TEST_DATABASE_URL")
	if url == "" {
		url = "postgres://ms:ms@127.0.0.1:5544/ms_test"
	}
	ctx := context.Background()
	var err error
	if testPool, err = db.Connect(ctx, url); err != nil && testutil.Required() {
		fmt.Println("FAIL: postgres unavailable and required (CI or MS_REQUIRE_DB=1):", err)
		os.Exit(1)
	} else if err != nil {
		fmt.Println("SKIP: postgres unavailable (run `docker compose up -d postgres` in platform/):", err)
		os.Exit(0)
	}
	if err := db.Migrate(ctx, testPool, migrations.FS); err != nil {
		panic(err)
	}
	os.Exit(m.Run())
}

func fresh(t *testing.T) (*Store, context.Context) {
	t.Helper()
	ctx := context.Background()
	if _, err := testPool.Exec(ctx, `TRUNCATE run_events, attempts, runs, sessions, agents, workers RESTART IDENTITY CASCADE`); err != nil {
		t.Fatal(err)
	}
	// snapshots are immutable by trigger; clear them by disabling it for the cleanup only
	if _, err := testPool.Exec(ctx, `ALTER TABLE snapshots DISABLE TRIGGER snapshots_no_update; TRUNCATE snapshots RESTART IDENTITY CASCADE; ALTER TABLE snapshots ENABLE TRIGGER snapshots_no_update`); err != nil {
		t.Fatal(err)
	}
	return New(testPool), ctx
}

func agent(id string, tools ...string) Agent {
	if len(tools) == 0 {
		tools = []string{"get_snapshot", "get_portfolio"}
	}
	return Agent{ID: id, Name: id, Instrument: "WTICO/USD", Granularity: "M5", Runtime: "mock", AllowedTools: tools, Enabled: true}
}

var seq int

func payload() json.RawMessage {
	return json.RawMessage(`{"close":100,"quote":{"last":100},"portfolio":{"halted":false,"positions":[{"id":7,"instrument":"WTICO/USD"}]}}`)
}

func ingest(t *testing.T, s *Store, ctx context.Context) IngestResult {
	t.Helper()
	seq++
	r, err := s.Ingest(ctx, IngestInput{IdemKey: fmt.Sprintf("k-%d-%d", time.Now().UnixNano(), seq), Instrument: "WTICO/USD", Granularity: "M5", Event: "flip", Source: "demo", Payload: payload()})
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func claim(t *testing.T, s *Store, ctx context.Context, worker string) *Claim {
	t.Helper()
	c, err := s.Claim(ctx, worker, []string{"mock"}, 30*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func expireLease(t *testing.T, attemptID int64) {
	t.Helper()
	if _, err := testPool.Exec(context.Background(), `UPDATE attempts SET lease_expires_at = now() - interval '1 second' WHERE id=$1`, attemptID); err != nil {
		t.Fatal(err)
	}
}

func hold() *domain.Decision { d := domain.Hold("test"); return &d }

func runStatus(t *testing.T, id int64) (status string, proposal *string) {
	t.Helper()
	if err := testPool.QueryRow(context.Background(), `SELECT status, proposal::text FROM runs WHERE id=$1`, id).Scan(&status, &proposal); err != nil {
		t.Fatal(err)
	}
	return
}

func TestIngestIsIdempotentAndScoped(t *testing.T) {
	s, ctx := fresh(t)
	must(t, s.UpsertAgent(ctx, agent("a1")))
	other := agent("a2")
	other.Granularity = "M1"
	must(t, s.UpsertAgent(ctx, other))
	off := agent("a3")
	off.Enabled = false
	must(t, s.UpsertAgent(ctx, off))

	in := IngestInput{IdemKey: "same", Instrument: "WTICO/USD", Granularity: "M5", Event: "flip", Source: "engine", Payload: payload()}
	r1, err := s.Ingest(ctx, in)
	must(t, err)
	r2, err := s.Ingest(ctx, in)
	must(t, err)
	if len(r1.Runs) != 1 || r1.Runs[0].AgentID != "a1" || !r1.Runs[0].Created {
		t.Fatalf("first ingest: %+v", r1)
	}
	if r2.NewSnap || r2.Runs[0].Created || r2.Runs[0].RunID != r1.Runs[0].RunID {
		t.Fatalf("replay must return the original run: %+v", r2)
	}
	var n int
	must(t, testPool.QueryRow(ctx, `SELECT count(*) FROM runs`).Scan(&n))
	if n != 1 {
		t.Fatalf("expected 1 run, got %d", n)
	}
}

func TestSnapshotsAreImmutable(t *testing.T) {
	s, ctx := fresh(t)
	must(t, s.UpsertAgent(ctx, agent("a1")))
	ingest(t, s, ctx)
	if _, err := testPool.Exec(ctx, `UPDATE snapshots SET payload='{}'`); err == nil {
		t.Fatal("snapshot update must fail")
	}
	if _, err := testPool.Exec(ctx, `DELETE FROM snapshots`); err == nil {
		t.Fatal("snapshot delete must fail")
	}
}

func TestConcurrentClaimsNeverDuplicate(t *testing.T) {
	s, ctx := fresh(t)
	must(t, s.UpsertAgent(ctx, agent("a1")))
	const runs = 12
	for i := 0; i < runs; i++ {
		ingest(t, s, ctx)
	}
	var mu sync.Mutex
	seen := map[int64]int{}
	var wg sync.WaitGroup
	for w := 0; w < 24; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			c, err := s.Claim(ctx, fmt.Sprintf("w%d", w), []string{"mock"}, time.Minute)
			if err != nil {
				t.Error(err)
				return
			}
			if c != nil {
				mu.Lock()
				seen[c.Run.ID]++
				mu.Unlock()
			}
		}(w)
	}
	wg.Wait()
	if len(seen) != runs {
		t.Fatalf("expected %d distinct claimed runs, got %d", runs, len(seen))
	}
	for id, n := range seen {
		if n != 1 {
			t.Fatalf("run %d claimed %d times", id, n)
		}
	}
}

func TestStaleWorkerCannotResurrectAReassignedRun(t *testing.T) {
	s, ctx := fresh(t)
	must(t, s.UpsertAgent(ctx, agent("a1")))
	ingest(t, s, ctx)
	a := claim(t, s, ctx, "worker-a")
	expireLease(t, a.Attempt.ID)
	res, err := s.Reap(ctx)
	must(t, err)
	if res.Expired != 1 {
		t.Fatalf("reap: %+v", res)
	}
	if _, err := s.Heartbeat(ctx, a.Attempt.ID, a.Attempt.Fence, time.Minute); !errors.Is(err, ErrStale) {
		t.Fatalf("stale heartbeat must be rejected, got %v", err)
	}
	if _, err := testPool.Exec(ctx, `UPDATE runs SET run_after=now()`); err != nil {
		t.Fatal(err)
	}
	b := claim(t, s, ctx, "worker-b")
	if b == nil || b.Run.ID != a.Run.ID || b.Attempt.Fence <= a.Attempt.Fence {
		t.Fatalf("expected reassignment with a higher fence: %+v", b)
	}
	if _, err := s.Complete(ctx, a.Attempt.ID, a.Attempt.Fence, CompleteInput{Proposal: hold()}); !errors.Is(err, ErrStale) {
		t.Fatalf("stale completion must be rejected, got %v", err)
	}
	if _, err := s.Complete(ctx, b.Attempt.ID, a.Attempt.Fence, CompleteInput{Proposal: hold()}); !errors.Is(err, ErrStale) {
		t.Fatalf("wrong fence must be rejected, got %v", err)
	}
	if _, err := s.Complete(ctx, b.Attempt.ID, b.Attempt.Fence, CompleteInput{Proposal: hold()}); err != nil {
		t.Fatal(err)
	}
	if st, _ := runStatus(t, a.Run.ID); st != "succeeded" {
		t.Fatalf("status %s", st)
	}
}

func TestDuplicateCompletionIsIdempotent(t *testing.T) {
	s, ctx := fresh(t)
	must(t, s.UpsertAgent(ctx, agent("a1")))
	ingest(t, s, ctx)
	c := claim(t, s, ctx, "w")
	o1, err := s.Complete(ctx, c.Attempt.ID, c.Attempt.Fence, CompleteInput{Proposal: hold(), Usage: map[string]float64{"tokens": 10}})
	must(t, err)
	o2, err := s.Complete(ctx, c.Attempt.ID, c.Attempt.Fence, CompleteInput{Proposal: hold(), Usage: map[string]float64{"tokens": 10}})
	must(t, err)
	if o1.Duplicate || !o2.Duplicate {
		t.Fatalf("second delivery must be flagged duplicate: %+v %+v", o1, o2)
	}
	var usage []byte
	must(t, testPool.QueryRow(ctx, `SELECT usage FROM runs WHERE id=$1`, c.Run.ID).Scan(&usage))
	if string(usage) != `{"tokens": 10}` {
		t.Fatalf("usage counted twice: %s", usage)
	}
}

func TestCancelWhileRunningDiscardsTheProposal(t *testing.T) {
	s, ctx := fresh(t)
	must(t, s.UpsertAgent(ctx, agent("a1")))
	ingest(t, s, ctx)
	c := claim(t, s, ctx, "w")
	out, err := s.Cancel(ctx, c.Run.ID)
	must(t, err)
	if out != "cancel_requested" {
		t.Fatal(out)
	}
	cancel, err := s.Heartbeat(ctx, c.Attempt.ID, c.Attempt.Fence, time.Minute)
	must(t, err)
	if !cancel {
		t.Fatal("heartbeat must report the cancellation")
	}
	if _, err := s.AuthorizeTool(ctx, c.Attempt.ID, c.Attempt.Fence, "get_snapshot", nil); !errors.Is(err, ErrCancelled) {
		t.Fatalf("tools must stop after cancel, got %v", err)
	}
	// the race: the worker finished just as the operator cancelled
	if _, err := s.Complete(ctx, c.Attempt.ID, c.Attempt.Fence, CompleteInput{Proposal: hold()}); !errors.Is(err, ErrCancelled) {
		t.Fatalf("completion after cancel must be refused, got %v", err)
	}
	st, prop := runStatus(t, c.Run.ID)
	if st != "cancelled" || prop != nil {
		t.Fatalf("cancelled run must hold no proposal: %s %v", st, prop)
	}
}

func TestCancelQueuedAndTerminal(t *testing.T) {
	s, ctx := fresh(t)
	must(t, s.UpsertAgent(ctx, agent("a1")))
	r := ingest(t, s, ctx)
	out, err := s.Cancel(ctx, r.Runs[0].RunID)
	must(t, err)
	if out != "cancelled" {
		t.Fatal(out)
	}
	if c := claim(t, s, ctx, "w"); c != nil {
		t.Fatal("a cancelled run must not be claimable")
	}
	if _, err := s.Cancel(ctx, r.Runs[0].RunID); !errors.Is(err, ErrTerminal) {
		t.Fatalf("got %v", err)
	}
}

func TestToolAllowlistAndBudgetAreEnforcedAtExecution(t *testing.T) {
	s, ctx := fresh(t)
	a := agent("a1", "get_snapshot")
	a.Budgets.MaxToolCalls = 2
	must(t, s.UpsertAgent(ctx, a))
	ingest(t, s, ctx)
	c := claim(t, s, ctx, "w")
	if _, err := s.AuthorizeTool(ctx, c.Attempt.ID, c.Attempt.Fence, "get_portfolio", nil); !errors.Is(err, ErrForbidden) {
		t.Fatalf("undeclared tool must be forbidden, got %v", err)
	}
	if _, err := s.AuthorizeTool(ctx, c.Attempt.ID, c.Attempt.Fence, "exec_shell", nil); !errors.Is(err, ErrForbidden) {
		t.Fatalf("got %v", err)
	}
	for i := 0; i < 2; i++ {
		if _, err := s.AuthorizeTool(ctx, c.Attempt.ID, c.Attempt.Fence, "get_snapshot", nil); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.AuthorizeTool(ctx, c.Attempt.ID, c.Attempt.Fence, "get_snapshot", nil); !errors.Is(err, ErrBudget) {
		t.Fatalf("budget must stop the third call, got %v", err)
	}
	var denied int
	must(t, testPool.QueryRow(ctx, `SELECT count(*) FROM run_events WHERE kind='tool_denied'`).Scan(&denied))
	if denied != 3 {
		t.Fatalf("every denial must be audited, got %d", denied)
	}
}

func TestExhaustedAttemptsEndInARecordedHold(t *testing.T) {
	s, ctx := fresh(t)
	a := agent("a1")
	a.Budgets.MaxAttempts = 2
	must(t, s.UpsertAgent(ctx, a))
	r := ingest(t, s, ctx)
	c := claim(t, s, ctx, "w")
	st, err := s.Fail(ctx, c.Attempt.ID, c.Attempt.Fence, "provider timeout", true)
	must(t, err)
	if st != "queued" {
		t.Fatalf("first failure must retry, got %s", st)
	}
	if claim(t, s, ctx, "w") != nil {
		t.Fatal("retry must wait for its backoff")
	}
	if _, err := testPool.Exec(ctx, `UPDATE runs SET run_after=now()`); err != nil {
		t.Fatal(err)
	}
	c = claim(t, s, ctx, "w")
	st, err = s.Fail(ctx, c.Attempt.ID, c.Attempt.Fence, "provider timeout", true)
	must(t, err)
	if st != "failed" {
		t.Fatalf("attempts exhausted must fail, got %s", st)
	}
	status, prop := runStatus(t, r.Runs[0].RunID)
	if status != "failed" || prop == nil {
		t.Fatalf("a failed run records a hold: %s %v", status, prop)
	}
	var p domain.Decision
	must(t, json.Unmarshal([]byte(*prop), &p))
	if p.Action != "hold" {
		t.Fatalf("failure must never produce a trade: %+v", p)
	}
}

func TestFollowupWaitsReleasesTheWorkerAndResumes(t *testing.T) {
	s, ctx := fresh(t)
	must(t, s.UpsertAgent(ctx, agent("a1")))
	r := ingest(t, s, ctx)
	c := claim(t, s, ctx, "w")
	must(t, s.SetPendingWait(ctx, c.Attempt.ID, c.Attempt.Fence, 30, "check the next bar"))
	out, err := s.Complete(ctx, c.Attempt.ID, c.Attempt.Fence, CompleteInput{Proposal: hold()})
	must(t, err)
	if out.Status != "waiting_for_event" {
		t.Fatalf("got %s", out.Status)
	}
	if claim(t, s, ctx, "w") != nil {
		t.Fatal("a waiting run must not be claimable before its deadline")
	}
	if _, err := testPool.Exec(ctx, `UPDATE runs SET wait_until = now() - interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	res, err := s.Reap(ctx)
	must(t, err)
	if res.Woken != 1 {
		t.Fatalf("reap: %+v", res)
	}
	c2 := claim(t, s, ctx, "w2")
	if c2 == nil || c2.Attempt.AttemptNo != 2 || c2.Run.ID != r.Runs[0].RunID {
		t.Fatalf("resumption must be a fresh second attempt: %+v", c2)
	}
	if string(c2.Notes) == "[]" {
		t.Fatal("the session must carry the earlier attempt's note")
	}
	out, err = s.Complete(ctx, c2.Attempt.ID, c2.Attempt.Fence, CompleteInput{Proposal: hold()})
	must(t, err)
	if out.Status != "succeeded" {
		t.Fatalf("got %s", out.Status)
	}
}

func TestInvalidProposalIsRecordedNeverCommitted(t *testing.T) {
	s, ctx := fresh(t)
	must(t, s.UpsertAgent(ctx, agent("a1")))
	ingest(t, s, ctx)
	c := claim(t, s, ctx, "w")
	bad := &domain.Decision{Action: "open", Side: "long", Notional: 100, Stop: 105} // stop above entry 100
	out, err := s.Complete(ctx, c.Attempt.ID, c.Attempt.Fence, CompleteInput{Proposal: bad})
	must(t, err)
	if out.Validation.Valid || out.Validation.Committed {
		t.Fatalf("wrong-side stop must be invalid and uncommitted: %+v", out.Validation)
	}
	var kinds int
	must(t, testPool.QueryRow(ctx, `SELECT count(*) FROM run_events WHERE kind='proposal_rejected'`).Scan(&kinds))
	if kinds != 1 {
		t.Fatal("rejection must be audited")
	}
}

func TestShadowComparisonInEitherArrivalOrder(t *testing.T) {
	s, ctx := fresh(t)
	must(t, s.UpsertAgent(ctx, agent("a1")))
	engine := func(key string) IngestResult {
		r, err := s.Ingest(ctx, IngestInput{IdemKey: key, Instrument: "WTICO/USD", Granularity: "M5", Event: "flip", Source: "engine", Payload: payload()})
		must(t, err)
		return r
	}
	cmp := func(id int64) string {
		var v string
		must(t, testPool.QueryRow(ctx, `SELECT comparison FROM runs WHERE id=$1`, id).Scan(&v))
		return v
	}
	// legacy arrives after the agent finished
	r1 := engine("e1")
	c := claim(t, s, ctx, "w")
	_, err := s.Complete(ctx, c.Attempt.ID, c.Attempt.Fence, CompleteInput{Proposal: hold()})
	must(t, err)
	if cmp(r1.Runs[0].RunID) != "pending" {
		t.Fatal("engine snapshot without a legacy decision stays pending")
	}
	_, err = s.SetLegacy(ctx, "e1", json.RawMessage(`{"decision":{"action":"hold"}}`))
	must(t, err)
	if cmp(r1.Runs[0].RunID) != "agree" {
		t.Fatal("hold vs hold must agree")
	}
	// legacy arrives first
	r2 := engine("e2")
	_, err = s.SetLegacy(ctx, "e2", json.RawMessage(`{"decision":{"action":"open","side":"long"}}`))
	must(t, err)
	c = claim(t, s, ctx, "w")
	_, err = s.Complete(ctx, c.Attempt.ID, c.Attempt.Fence, CompleteInput{Proposal: hold()})
	must(t, err)
	if cmp(r2.Runs[0].RunID) != "differ" {
		t.Fatal("hold vs open must differ")
	}
}

func TestQueuedRunsExpireInsteadOfGoingStale(t *testing.T) {
	s, ctx := fresh(t)
	a := agent("a1")
	a.Budgets.DeadlineSeconds = 60
	must(t, s.UpsertAgent(ctx, a))
	r := ingest(t, s, ctx)
	if _, err := testPool.Exec(ctx, `UPDATE runs SET run_after = now() - interval '2 minutes'`); err != nil {
		t.Fatal(err)
	}
	res, err := s.Reap(ctx)
	must(t, err)
	if res.Aged != 1 {
		t.Fatalf("reap: %+v", res)
	}
	if st, _ := runStatus(t, r.Runs[0].RunID); st != "expired" {
		t.Fatalf("status %s", st)
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func TestIngestRejectsAnOversizedSnapshot(t *testing.T) {
	s, ctx := fresh(t)
	must(t, s.UpsertAgent(ctx, agent("a1")))
	big := json.RawMessage(`{"pad":"` + strings.Repeat("x", MaxSnapshotBytes) + `"}`)
	_, err := s.Ingest(ctx, IngestInput{IdemKey: "big", Instrument: "WTICO/USD", Granularity: "M5", Event: "flip", Source: "engine", Payload: big})
	if err == nil {
		t.Fatal("a snapshot over the cap must be refused, not stored and later cut into invalid JSON")
	}
	var n int
	must(t, testPool.QueryRow(ctx, `SELECT count(*) FROM snapshots`).Scan(&n))
	if n != 0 {
		t.Fatalf("nothing may be stored for a refused snapshot, found %d", n)
	}
}

func TestRejectedProposalComparesAsHold(t *testing.T) {
	open := []byte(`{"action":"open","side":"long"}`)
	legacyOpen := []byte(`{"action":"open","side":"long"}`)
	legacyHold := []byte(`{"action":"hold"}`)
	rejected := []byte(`{"valid":false}`)
	if got := compareJSON(open, rejected, legacyOpen); got != "differ" {
		t.Errorf("rejected open vs engine open: %s, want differ", got)
	}
	if got := compareJSON(open, rejected, legacyHold); got != "agree" {
		t.Errorf("rejected open vs engine hold: %s, want agree", got)
	}
	if got := compareJSON(open, []byte(`{"valid":true}`), legacyOpen); got != "agree" {
		t.Errorf("valid open vs engine open: %s, want agree", got)
	}
}
