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
