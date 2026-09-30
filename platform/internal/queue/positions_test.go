package queue

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/mfittko/market-signals/platform/internal/domain"
)

func fptr(v float64) *float64 { return &v }

// runAs ingests one snapshot from a source, claims it and completes it with the proposal.
func runAs(t *testing.T, s *Store, ctx context.Context, source, pl string, p domain.Decision) *CompleteOutcome {
	t.Helper()
	return runAsAgent(t, s, ctx, "a1", source, pl, p)
}

func runAsAgent(t *testing.T, s *Store, ctx context.Context, agentID, source, pl string, p domain.Decision) *CompleteOutcome {
	t.Helper()
	seq++
	_, err := s.Ingest(ctx, IngestInput{IdemKey: fmt.Sprintf("p-%d-%d", time.Now().UnixNano(), seq), Instrument: "WTICO/USD", Granularity: "M5",
		Event: "flip", Source: source, Trigger: "test", Payload: json.RawMessage(pl), AgentID: agentID})
	must(t, err)
	c := claim(t, s, ctx, "w")
	if c == nil {
		t.Fatal("nothing to claim")
	}
	o, err := s.Complete(ctx, c.Attempt.ID, c.Attempt.Fence, CompleteInput{Proposal: &p})
	must(t, err)
	return o
}

func openDecision() domain.Decision {
	return domain.Decision{Action: "open", Side: "long", Notional: 1000, Stop: 98, Target: fptr(106), Reasoning: "test",
		Plan: &domain.Plan{MaxBars: 30, Trail: &domain.Trail{Kind: "atr", Mult: 2}, Tripwires: []domain.Tripwire{{Kind: "adverse_atr", ATR: 1.5}}}}
}

const entryPayload = `{"close":100,"quote":{"last":100},"portfolio":{"halted":false,"positions":[]}}`

func TestAcceptedEngineEntryOpensOneShadowPositionWithItsPlan(t *testing.T) {
	s, ctx := fresh(t)
	must(t, s.UpsertAgent(ctx, agent("a1")))
	runAs(t, s, ctx, "engine", entryPayload, openDecision())
	ps, err := s.ListPositions(ctx, "open", 10)
	must(t, err)
	if len(ps) != 1 {
		t.Fatalf("positions %+v", ps)
	}
	p := ps[0]
	if p.Side != "long" || p.EntryPrice != 100 || p.Stop != 98 || p.InitialStop != 98 || p.Plan.MaxBars != 30 || len(p.Plan.Tripwires) != 1 || p.Best != 100 {
		t.Fatalf("%+v", p)
	}
	// a second accepted entry while one is open does not stack
	runAs(t, s, ctx, "engine", entryPayload, openDecision())
	if all, _ := s.ListPositions(ctx, "", 10); len(all) != 1 {
		t.Fatalf("one open position per agent, got %d", len(all))
	}
}

func TestOnlyValidEngineEntriesOpenPositions(t *testing.T) {
	s, ctx := fresh(t)
	must(t, s.UpsertAgent(ctx, agent("a1")))
	runAs(t, s, ctx, "operator", entryPayload, openDecision()) // a manual check executes nothing
	bad := openDecision()
	bad.Stop = 101 // wrong side of a long entry at 100
	runAs(t, s, ctx, "engine", entryPayload, bad)
	runAs(t, s, ctx, "engine", entryPayload, domain.Hold("no"))
	if all, _ := s.ListPositions(ctx, "", 10); len(all) != 0 {
		t.Fatalf("no position expected: %+v", all)
	}
}

func wakePayload(id int64, stop float64) string {
	return fmt.Sprintf(`{"close":101,"quote":{"last":101},"wake":{"positionId":%d,"side":"long","entry":100,"stop":%v,"price":101,"tripwire":"adverse_atr"}}`, id, stop)
}

func TestWakeMayTightenReplaceTripwiresOrCloseButNeverWiden(t *testing.T) {
	s, ctx := fresh(t)
	must(t, s.UpsertAgent(ctx, agent("a1")))
	runAs(t, s, ctx, "engine", entryPayload, openDecision())
	p := func() Position { ps, _ := s.ListPositions(ctx, "", 10); return ps[0] }
	id := p().ID

	// widening is rejected and recorded as a hold: the stop stays
	o := runAs(t, s, ctx, "monitor", wakePayload(id, 98), domain.Decision{Action: "tighten_stop", PositionID: id, NewStop: fptr(97)})
	if o.Validation.Valid || p().Stop != 98 {
		t.Fatalf("widening must be refused: %+v stop=%v", o.Validation, p().Stop)
	}
	// tightening toward price moves the stop
	runAs(t, s, ctx, "monitor", wakePayload(id, 98), domain.Decision{Action: "tighten_stop", PositionID: id, NewStop: fptr(99.5)})
	if p().Stop != 99.5 {
		t.Fatalf("stop %v", p().Stop)
	}
	// a stale tighten that would loosen the stop the monitor already trailed is ignored
	runAs(t, s, ctx, "monitor", wakePayload(id, 98), domain.Decision{Action: "tighten_stop", PositionID: id, NewStop: fptr(99)})
	if p().Stop != 99.5 {
		t.Fatalf("a stale tighten must not loosen: %v", p().Stop)
	}
	// replacing tripwires
	runAs(t, s, ctx, "monitor", wakePayload(id, 99.5), domain.Decision{Action: "set_tripwires", PositionID: id, Tripwires: []domain.Tripwire{{Kind: "opposite_flip"}}})
	if tw := p().Plan.Tripwires; len(tw) != 1 || tw[0].Kind != "opposite_flip" || p().Plan.MaxBars != 30 {
		t.Fatalf("plan %+v", p().Plan)
	}
	// a wake cannot open, and cannot act on another position
	if o := runAs(t, s, ctx, "monitor", wakePayload(id, 99.5), openDecision()); o.Validation.Valid {
		t.Fatal("open from a wake must be refused")
	}
	if o := runAs(t, s, ctx, "monitor", wakePayload(id, 99.5), domain.Decision{Action: "close", PositionID: id + 1}); o.Validation.Valid {
		t.Fatal("acting on another position must be refused")
	}
	// close settles at the snapshot price with the realized result
	runAs(t, s, ctx, "monitor", wakePayload(id, 99.5), domain.Decision{Action: "close", PositionID: id})
	if q := p(); q.Status != "closed" || q.ExitReason != "agent_close" || q.Realized == nil || *q.Realized != 10 {
		t.Fatalf("%+v", q)
	}
	_, ev, err := s.GetPosition(ctx, id)
	must(t, err)
	kinds := map[string]int{}
	for _, e := range ev {
		kinds[e.Kind]++
	}
	if kinds["opened"] != 1 || kinds["tighten"] != 1 || kinds["tripwires"] != 1 || kinds["exit"] != 1 || kinds["wake_hold"] < 1 {
		t.Fatalf("events %v", kinds)
	}
}

func TestClosePositionResolvesOnceAndSaveOnlyTouchesOpenPositions(t *testing.T) {
	s, ctx := fresh(t)
	must(t, s.UpsertAgent(ctx, agent("a1")))
	runAs(t, s, ctx, "engine", entryPayload, openDecision())
	ps, _ := s.ListPositions(ctx, "open", 1)
	id := ps[0].ID
	first, err := s.ClosePosition(ctx, id, 98, time.Now(), "stop")
	must(t, err)
	again, err := s.ClosePosition(ctx, id, 105, time.Now(), "target")
	must(t, err)
	if !first || again {
		t.Fatalf("a position closes once: %v %v", first, again)
	}
	q, _, _ := s.GetPosition(ctx, id)
	if q.ExitPrice == nil || *q.ExitPrice != 98 || *q.Realized != -20 {
		t.Fatalf("%+v", q)
	}
	q.Stop = 50
	if st, err := s.SavePosition(ctx, *q); err != nil || st != 0 {
		t.Fatalf("a closed position reports no stop: %v %v", st, err)
	}
	if r, _, _ := s.GetPosition(ctx, id); r.Stop == 50 {
		t.Fatal("a closed position must not change")
	}
}

func TestThreeUnansweredWakesInARowRaiseAttentionAndAreCountedOnce(t *testing.T) {
	s, ctx := fresh(t)
	must(t, s.UpsertAgent(ctx, agent("a1")))
	runAs(t, s, ctx, "engine", entryPayload, openDecision())
	ps, _ := s.ListPositions(ctx, "open", 1)
	id := ps[0].ID
	for i := 0; i < MaxFailedWakes; i++ {
		seq++
		r, err := s.Ingest(ctx, IngestInput{IdemKey: fmt.Sprintf("wf-%d-%d", time.Now().UnixNano(), seq), Instrument: "WTICO/USD", Granularity: "M5", Event: "tripwire",
			Source: "monitor", Trigger: "tripwire:adverse_atr", Payload: json.RawMessage(wakePayload(id, 98)), AgentID: "a1"})
		must(t, err)
		must(t, s.RecordWake(ctx, id, r.Runs[0].RunID, map[string]any{"tripwire": "adverse_atr"}))
		_, err = testPool.Exec(ctx, `UPDATE runs SET status='failed' WHERE id=$1`, r.Runs[0].RunID)
		must(t, err)
	}
	n, err := s.ReconcileFailedWakes(ctx, id)
	must(t, err)
	again, err := s.ReconcileFailedWakes(ctx, id)
	must(t, err)
	p, ev, _ := s.GetPosition(ctx, id)
	if n != 3 || again != 0 || p.FailedWakes != 3 || !p.NeedsAttention || p.Status != "open" {
		t.Fatalf("n=%d again=%d %+v", n, again, p)
	}
	kinds := map[string]int{}
	for _, e := range ev {
		kinds[e.Kind]++
	}
	if kinds["wake_failed"] != 3 || kinds["attention"] != 1 || kinds["wake"] != 3 {
		t.Fatalf("%v", kinds)
	}
	ws, err := s.WakeState(ctx, id, time.Now())
	must(t, err)
	if ws.InFlight || ws.Last24h != 3 {
		t.Fatalf("%+v", ws)
	}
	// any answered wake clears the failure streak
	runAs(t, s, ctx, "monitor", wakePayload(id, 98), domain.Decision{Action: "hold", Reasoning: "fine"})
	if q, _, _ := s.GetPosition(ctx, id); q.FailedWakes != 0 {
		t.Fatalf("an answer must reset the streak: %d", q.FailedWakes)
	}
}

// A wake can tighten the stop or replace the tripwires while the monitor waits on the feed.
// The monitor's later save must never undo either.
func TestMonitorSaveNeverWidensTheStopOrRewritesThePlan(t *testing.T) {
	s, ctx := fresh(t)
	must(t, s.UpsertAgent(ctx, agent("a1")))
	runAs(t, s, ctx, "engine", entryPayload, openDecision())
	ps, _ := s.ListPositions(ctx, "open", 1)
	id := ps[0].ID
	stale, _, _ := s.GetPosition(ctx, id) // what the monitor read at the start of its tick
	long := stale.Side == "long"

	tighter := stale.Stop + 4
	if !long {
		tighter = stale.Stop - 4
	}
	_, err := s.Pool.Exec(ctx, `UPDATE shadow_positions SET stop=$2, plan=jsonb_set(plan,'{tripwires}','[]'::jsonb), last_fired='{}' WHERE id=$1`, id, tighter)
	must(t, err)

	stale.BarsHeld, stale.LastClose = 7, stale.EntryPrice
	stale.LastFired = map[string]int{"adverse_atr": 3}
	got, err := s.SavePosition(ctx, *stale) // carries the old stop and the old plan
	must(t, err)
	if got != tighter {
		t.Fatalf("the stored stop must stay at the tighter value %v, got %v", tighter, got)
	}
	after, _, _ := s.GetPosition(ctx, id)
	if after.Stop != tighter || len(after.Plan.Tripwires) != 0 {
		t.Fatalf("the wake's stop and tripwires must survive: %+v", after)
	}
	if after.BarsHeld != 7 || after.LastFired["adverse_atr"] != 3 {
		t.Fatalf("the monitor's own progress must be saved: %+v", after)
	}
}

// The session keeps the twenty newest notes, oldest first. A wrong sort once pinned the first notes forever.
func TestSessionKeepsTheNewestTwentyNotesInOrder(t *testing.T) {
	s, ctx := fresh(t)
	must(t, s.UpsertAgent(ctx, agent("a1")))
	for i := 0; i < 25; i++ {
		runAs(t, s, ctx, "engine", entryPayload, domain.Hold("wait"))
	}
	var n int
	var first, last int64
	var maxRun int64
	must(t, s.Pool.QueryRow(ctx, `SELECT max(id) FROM runs`).Scan(&maxRun))
	must(t, s.Pool.QueryRow(ctx, `SELECT jsonb_array_length(notes), (notes->0->>'run')::bigint, (notes->-1->>'run')::bigint FROM sessions LIMIT 1`).Scan(&n, &first, &last))
	if n != 20 || last != maxRun || first != maxRun-19 {
		t.Fatalf("want 20 notes for runs %d..%d, got %d notes for %d..%d", maxRun-19, maxRun, n, first, last)
	}
}

// A woken close fills at the monitor's fresh bar close, not at a snapshot the model took minutes ago.
func TestWakeCloseFillsAtTheFreshBarCloseWhenTheMonitorHasOne(t *testing.T) {
	s, ctx := fresh(t)
	must(t, s.UpsertAgent(ctx, agent("a1")))
	runAs(t, s, ctx, "engine", entryPayload, openDecision())
	ps, _ := s.ListPositions(ctx, "open", 1)
	id := ps[0].ID
	_, err := s.Pool.Exec(ctx, `UPDATE shadow_positions SET last_close=101, last_bar_time=$2 WHERE id=$1`, id, time.Now().UTC())
	must(t, err)
	runAs(t, s, ctx, "monitor", wakePayload(id, 105), domain.Decision{Action: "close", PositionID: id})
	q, _, _ := s.GetPosition(ctx, id)
	if q.Status != "closed" || q.ExitPrice == nil || *q.ExitPrice != 101 {
		t.Fatalf("the fill must use the fresh bar close (101), not the stale snapshot (105): %+v", q)
	}
}

// Follow-up wakes are not retries: a run that used its follow-ups still gets its retry budget.
func TestFollowupsDoNotConsumeTheRetryBudget(t *testing.T) {
	s, ctx := fresh(t)
	must(t, s.UpsertAgent(ctx, agent("a1")))
	_, err := s.Ingest(ctx, IngestInput{IdemKey: "fu-budget", Instrument: "WTICO/USD", Granularity: "M5", Event: "flip", Source: "engine", Trigger: "test", Payload: json.RawMessage(entryPayload), AgentID: "a1"})
	must(t, err)
	c := claim(t, s, ctx, "w")
	must(t, err)
	_, err = s.Pool.Exec(ctx, `UPDATE runs SET attempts_made=3, followups_used=2, max_attempts=3 WHERE id=$1`, c.Run.ID)
	must(t, err)
	st, err := s.Fail(ctx, c.Attempt.ID, c.Attempt.Fence, "transient", true)
	must(t, err)
	if st != "queued" {
		t.Fatalf("a retryable error after two follow-ups must still be retried, got %q", st)
	}
}

// A wake key only counts when the monitor wrote the snapshot, and a wake only
// acts on a position that belongs to the run's agent.
func TestWakeNeedsTheMonitorSourceAndTheOwningAgent(t *testing.T) {
	s, ctx := fresh(t)
	must(t, s.UpsertAgent(ctx, agent("a1")))
	must(t, s.UpsertAgent(ctx, agent("a2")))
	runAs(t, s, ctx, "engine", entryPayload, openDecision())
	ps, _ := s.ListPositions(ctx, "", 10)
	id := ps[0].ID
	_, before, err := s.GetPosition(ctx, id)
	must(t, err)

	// an engine event that carries a wake key is plain payload data
	runAs(t, s, ctx, "engine", wakePayload(id, 98), domain.Decision{Action: "close", PositionID: id})
	runAs(t, s, ctx, "engine", wakePayload(id, 98), domain.Decision{Action: "tighten_stop", PositionID: id, NewStop: fptr(99.5)})
	// another agent's wake cannot touch this position
	runAsAgent(t, s, ctx, "a2", "monitor", wakePayload(id, 98), domain.Decision{Action: "close", PositionID: id})
	runAsAgent(t, s, ctx, "a2", "monitor", wakePayload(id, 98), domain.Decision{Action: "tighten_stop", PositionID: id, NewStop: fptr(99.5)})
	runAsAgent(t, s, ctx, "a2", "monitor", wakePayload(id, 98), domain.Decision{Action: "tighten_stop", PositionID: id, NewStop: fptr(97)})

	p, after, err := s.GetPosition(ctx, id)
	must(t, err)
	if p.Status != "open" || p.Stop != 98 || len(after) != len(before) {
		t.Fatalf("position must be untouched: %+v events %d -> %d", p, len(before), len(after))
	}
	// the owner's monitor wake still acts
	runAs(t, s, ctx, "monitor", wakePayload(id, 98), domain.Decision{Action: "close", PositionID: id})
	if p, _, _ := s.GetPosition(ctx, id); p.Status != "closed" {
		t.Fatalf("owner wake must close: %+v", p)
	}
}
