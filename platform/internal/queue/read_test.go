package queue

import (
	"encoding/json"
	"testing"
)

func TestAgentsCanBeListedFetchedAndSwitched(t *testing.T) {
	s, ctx := fresh(t)
	must(t, s.UpsertAgent(ctx, agent("a1")))
	must(t, s.UpsertAgent(ctx, agent("a2")))
	list, err := s.ListAgents(ctx)
	if err != nil || len(list) != 2 {
		t.Fatalf("list: %v %d", err, len(list))
	}
	a, err := s.GetAgent(ctx, "a1")
	if err != nil || a.ID != "a1" || !a.Enabled || len(a.AllowedTools) != 2 {
		t.Fatalf("get: %v %+v", err, a)
	}
	must(t, s.SetEnabled(ctx, "a1", false))
	if a, _ = s.GetAgent(ctx, "a1"); a.Enabled {
		t.Fatal("the agent must be switched off")
	}
	if _, err := s.GetAgent(ctx, "nope"); err == nil {
		t.Fatal("an unknown agent must be an error")
	}
	if err := s.SetEnabled(ctx, "nope", true); err == nil {
		t.Fatal("switching an unknown agent must be an error")
	}
}

func TestRunListDetailEventsAndStatsFollowARunThroughItsLife(t *testing.T) {
	s, ctx := fresh(t)
	must(t, s.UpsertAgent(ctx, agent("a1")))
	must(t, s.RegisterWorker(ctx, "w1", []string{"mock"}, json.RawMessage(`{"tools":true}`)))
	r := ingest(t, s, ctx)
	runID := r.Runs[0].RunID

	rows, err := s.ListRuns(ctx, RunFilter{Status: "queued", AgentID: "a1", Limit: 5})
	if err != nil || len(rows) != 1 || rows[0].ID != runID || rows[0].Instrument != "WTICO/USD" {
		t.Fatalf("queued list: %v %+v", err, rows)
	}
	if rows, _ = s.ListRuns(ctx, RunFilter{Status: "succeeded"}); len(rows) != 0 {
		t.Fatalf("filter must exclude other statuses: %+v", rows)
	}

	c := claim(t, s, ctx, "w1")
	if c == nil {
		t.Fatal("expected a claim")
	}
	cancel, err := s.AppendEvent(ctx, c.Attempt.ID, c.Attempt.Fence, "note", json.RawMessage(`{"n":1}`))
	if err != nil || cancel {
		t.Fatalf("append: %v cancel=%v", err, cancel)
	}

	d, err := s.GetRun(ctx, runID)
	if err != nil || d.Run.Status != "running" || len(d.Attempts) != 1 || len(d.Events) == 0 {
		t.Fatalf("detail: %v %+v", err, d)
	}
	if _, err := s.GetRun(ctx, 99999); err == nil {
		t.Fatal("an unknown run must be an error")
	}

	after, err := s.EventsAfter(ctx, 0, 100)
	if err != nil || len(after) == 0 {
		t.Fatalf("events: %v %d", err, len(after))
	}
	if rest, _ := s.EventsAfter(ctx, after[len(after)-1].ID, 100); len(rest) != 0 {
		t.Fatalf("nothing is newer than the last event: %d", len(rest))
	}

	st, err := s.Stats(ctx)
	if err != nil || st.ByStatus["running"] != 1 || len(st.Workers) != 1 || !st.Workers[0].Online || st.LatestEvt == 0 {
		t.Fatalf("stats: %v %+v", err, st)
	}
}

func TestCancelOfARunningAttemptIsAcknowledgedByTheWorker(t *testing.T) {
	s, ctx := fresh(t)
	must(t, s.UpsertAgent(ctx, agent("a1")))
	runID := ingest(t, s, ctx).Runs[0].RunID
	c := claim(t, s, ctx, "w1")

	if status, err := s.Cancel(ctx, runID); err != nil || status != "cancel_requested" {
		t.Fatalf("cancel: %v %s", err, status)
	}
	if cancel, err := s.AppendEvent(ctx, c.Attempt.ID, c.Attempt.Fence, "note", json.RawMessage(`{}`)); err != nil || !cancel {
		t.Fatalf("the worker must be told to stop: %v cancel=%v", err, cancel)
	}
	must(t, s.AckCancel(ctx, c.Attempt.ID, c.Attempt.Fence))
	must(t, s.AckCancel(ctx, c.Attempt.ID, c.Attempt.Fence)) // a duplicate ack changes nothing
	if status, _ := runStatus(t, runID); status != "cancelled" {
		t.Fatalf("run must end cancelled, got %s", status)
	}
	if err := s.AckCancel(ctx, c.Attempt.ID, c.Attempt.Fence+99); err == nil {
		t.Fatal("a wrong fence must be refused")
	}
}

func TestStatsReportQueueAgeLeasesAndCancelRequests(t *testing.T) {
	s, ctx := fresh(t)
	must(t, s.UpsertAgent(ctx, agent("a1")))
	var claims []*Claim
	for range 4 {
		ingest(t, s, ctx)
		c := claim(t, s, ctx, "w1")
		if c == nil {
			t.Fatal("expected a claim")
		}
		claims = append(claims, c)
	}
	for i, at := range []string{"60 seconds", "5 seconds", "-1 second"} {
		if _, err := testPool.Exec(ctx, `UPDATE attempts SET lease_expires_at = now() + $2::interval WHERE id=$1`, claims[i].Attempt.ID, at); err != nil {
			t.Fatal(err)
		}
	}
	// a pending cancel counts; an acknowledged one ends the run and no longer does
	for _, c := range claims[1:] {
		if status, err := s.Cancel(ctx, c.Attempt.RunID); err != nil || status != "cancel_requested" {
			t.Fatalf("cancel: %v %s", err, status)
		}
	}
	must(t, s.AckCancel(ctx, claims[3].Attempt.ID, claims[3].Attempt.Fence))

	due, backoff := ingest(t, s, ctx).Runs[0].RunID, ingest(t, s, ctx).Runs[0].RunID
	for id, at := range map[int64]string{due: "-30 seconds", backoff: "60 seconds"} {
		if _, err := testPool.Exec(ctx, `UPDATE runs SET run_after = now() + $2::interval, created_at = now() - interval '1 hour' WHERE id=$1`, id, at); err != nil {
			t.Fatal(err)
		}
	}

	st, err := s.Stats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if st.OldestQueued < 29 || st.OldestQueued > 31 {
		t.Fatalf("oldestQueuedSeconds %v, want about 30: the run in backoff must not count", st.OldestQueued)
	}
	if want := (Leases{Running: 3, ExpiringSoon: 1, Expired: 1}); st.Leases != want {
		t.Fatalf("leases %+v, want %+v", st.Leases, want)
	}
	if st.CancelRequested != 2 {
		t.Fatalf("cancelRequested %d, want 2", st.CancelRequested)
	}

	// nothing claimable: the age is 0
	if _, err := testPool.Exec(ctx, `UPDATE runs SET run_after = now() + interval '60 seconds' WHERE id=$1`, due); err != nil {
		t.Fatal(err)
	}
	if st, err = s.Stats(ctx); err != nil || st.OldestQueued != 0 {
		t.Fatalf("no claimable run: %v %v", err, st.OldestQueued)
	}
}
