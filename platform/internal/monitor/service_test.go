package monitor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/mfittko/market-signals/platform/internal/domain"
	"github.com/mfittko/market-signals/platform/internal/queue"
	"github.com/mfittko/market-signals/platform/internal/testutil"
)

type fakeFeed struct {
	m   Market
	err error
}

func (f *fakeFeed) Market(context.Context, string, string) (Market, error) { return f.m, f.err }

type rig struct {
	t    *testing.T
	ctx  context.Context
	st   *queue.Store
	feed *fakeFeed
	svc  *Service
	base time.Time // the first minute after the entry
}

func newRig(t *testing.T, plan *domain.Plan) *rig {
	t.Helper()
	pool := testutil.Pool(t)
	ctx := context.Background()
	st := queue.New(pool)
	if err := st.UpsertAgent(ctx, queue.Agent{ID: "a1", Name: "a1", Instrument: "WTICO/USD", Granularity: "M5", Runtime: "mock",
		AllowedTools: []string{"get_snapshot"}, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	// an accepted engine entry: long at 100, stop 98, target 106
	_, err := st.Ingest(ctx, queue.IngestInput{IdemKey: fmt.Sprintf("open-%d", time.Now().UnixNano()), Instrument: "WTICO/USD", Granularity: "M5", Event: "flip",
		Source: "engine", Trigger: "flip", Payload: json.RawMessage(`{"close":100,"quote":{"last":100},"portfolio":{"halted":false,"positions":[]}}`)})
	if err != nil {
		t.Fatal(err)
	}
	c, err := st.Claim(ctx, "w", []string{"mock"}, 30*time.Second)
	if err != nil || c == nil {
		t.Fatal("claim", err)
	}
	tgt := 106.0
	if _, err := st.Complete(ctx, c.Attempt.ID, c.Attempt.Fence, queue.CompleteInput{Proposal: &domain.Decision{Action: "open", Side: "long", Notional: 1000, Stop: 98, Target: &tgt, Plan: plan}}); err != nil {
		t.Fatal(err)
	}
	f := &fakeFeed{}
	r := &rig{t: t, ctx: ctx, st: st, feed: f, base: time.Now().Truncate(time.Minute).Add(time.Minute)}
	r.svc = &Service{Store: st, Feed: f, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Now: func() time.Time { return r.base.Add(30 * time.Minute) }}
	return r
}

// bars appends bars starting n minutes after the base minute: o, h, l, c.
func (r *rig) bar(minute int, o, h, l, c float64) {
	r.feed.m.Bars = append(r.feed.m.Bars, Bar{Time: r.base.Add(time.Duration(minute) * time.Minute), Open: o, High: h, Low: l, Close: c, Volume: 10})
}

func (r *rig) tick() {
	r.t.Helper()
	if err := r.svc.Tick(r.ctx); err != nil {
		r.t.Fatal(err)
	}
}

func (r *rig) pos() queue.Position {
	r.t.Helper()
	ps, err := r.st.ListPositions(r.ctx, "", 5)
	if err != nil || len(ps) == 0 {
		r.t.Fatal("no position", err)
	}
	return ps[0]
}

func (r *rig) events() map[string]int {
	_, ev, err := r.st.GetPosition(r.ctx, r.pos().ID)
	if err != nil {
		r.t.Fatal(err)
	}
	k := map[string]int{}
	for _, e := range ev {
		k[e.Kind]++
	}
	return k
}

func (r *rig) wakeRuns() int {
	var n int
	if err := r.st.Pool.QueryRow(r.ctx, `SELECT count(*) FROM runs r JOIN snapshots s ON s.id=r.snapshot_id WHERE s.source='monitor'`).Scan(&n); err != nil {
		r.t.Fatal(err)
	}
	return n
}

func TestQuietBarsAdvanceOnceAndNeverRepeat(t *testing.T) {
	r := newRig(t, &domain.Plan{})
	r.bar(0, 100, 100.5, 99.8, 100.2)
	r.bar(1, 100.2, 100.6, 99.9, 100.1)
	r.bar(2, 100.1, 100.4, 99.7, 100.3)
	r.tick()
	r.tick() // the same bars again must not count twice
	p := r.pos()
	if p.Status != "open" || p.BarsHeld != 3 || p.LastBarTime == nil || !p.LastBarTime.Equal(r.base.Add(2*time.Minute)) || p.LastClose != 100.3 {
		t.Fatalf("%+v", p)
	}
}

func TestBarsBeforeTheEntryAreIgnored(t *testing.T) {
	r := newRig(t, &domain.Plan{})
	r.feed.m.Bars = append(r.feed.m.Bars, Bar{Time: r.base.Add(-10 * time.Minute), Open: 100, High: 100, Low: 50, Close: 60}) // would hit the stop
	r.bar(0, 100, 100.4, 99.6, 100)
	r.tick()
	if p := r.pos(); p.Status != "open" || p.BarsHeld != 1 {
		t.Fatalf("history before the entry must not act on the position: %+v", p)
	}
}

func TestStopFillClosesAtTheStopWithRealizedResult(t *testing.T) {
	r := newRig(t, &domain.Plan{})
	r.bar(0, 100, 100.5, 99.5, 100)
	r.bar(1, 99, 99.2, 97.5, 98.5)
	r.tick()
	p := r.pos()
	if p.Status != "closed" || p.ExitReason != "stop" || p.ExitPrice == nil || *p.ExitPrice != 98 || *p.Realized != -20 {
		t.Fatalf("%+v", p)
	}
	r.tick()
	if r.pos().BarsHeld != 1 {
		t.Fatal("a closed position is not advanced")
	}
}

func TestTrailedStopIsPersistedAndFillsLater(t *testing.T) {
	r := newRig(t, &domain.Plan{Trail: &domain.Trail{Kind: "atr", Mult: 2}})
	r.feed.m.ATR = 1
	r.bar(0, 100, 104.2, 100, 104)
	r.tick()
	if p := r.pos(); p.Stop != 102 || r.events()["trail"] != 1 {
		t.Fatalf("stop %v events %v", p.Stop, r.events())
	}
	r.bar(1, 103, 103.2, 101.5, 102.5) // touches the trailed stop, not the original one
	r.tick()
	if p := r.pos(); p.Status != "closed" || p.ExitReason != "stop" || *p.ExitPrice != 102 {
		t.Fatalf("%+v", p)
	}
}

func TestHaltedEngineClosesAtTheBarClose(t *testing.T) {
	r := newRig(t, &domain.Plan{})
	r.feed.m.Halted = true
	r.bar(0, 100, 100.4, 99.6, 100.2)
	r.tick()
	if p := r.pos(); p.Status != "closed" || p.ExitReason != "kill_switch" || *p.ExitPrice != 100.2 {
		t.Fatalf("%+v", p)
	}
}

func TestFeedErrorLeavesThePositionUntouchedAndCatchesUpLater(t *testing.T) {
	r := newRig(t, &domain.Plan{})
	r.bar(0, 100, 100.4, 99.6, 100.2)
	r.feed.err = errors.New("engine down")
	r.tick()
	if r.pos().BarsHeld != 0 {
		t.Fatal("no bars may be applied while the feed is down")
	}
	r.feed.err = nil
	r.tick()
	if r.pos().BarsHeld != 1 {
		t.Fatal("the next tick catches up")
	}
}

func TestTripwireWakesTheAgentOnceAndInFlightWakesBlockTheNext(t *testing.T) {
	r := newRig(t, &domain.Plan{Tripwires: []domain.Tripwire{{Kind: "adverse_atr", ATR: 1.5}}})
	r.feed.m.ATR = 1
	r.bar(0, 100, 100.2, 98.3, 98.4) // 1.6 ATR against entry, low above the stop
	r.tick()
	r.tick()
	if r.wakeRuns() != 1 || r.pos().Wakes != 1 {
		t.Fatalf("one wake expected: runs=%d wakes=%d", r.wakeRuns(), r.pos().Wakes)
	}
	var trig, payload string
	if err := r.st.Pool.QueryRow(r.ctx, `SELECT ru.trigger, s.payload::text FROM runs ru JOIN snapshots s ON s.id=ru.snapshot_id WHERE s.source='monitor'`).Scan(&trig, &payload); err != nil {
		t.Fatal(err)
	}
	var pl map[string]any
	_ = json.Unmarshal([]byte(payload), &pl)
	w := domain.WakeFromPayload(pl)
	if trig != "tripwire:adverse_atr" || w == nil || w.ID != r.pos().ID || w.Stop != 98 || w.Price != 98.4 || pl["position"] == nil {
		t.Fatalf("trigger %q wake %+v payload %s", trig, w, payload)
	}
	// the tripwire is on a cooldown of five held bars; when it fires again the first wake is still unanswered
	for i := 1; i <= CooldownBars; i++ {
		r.bar(i, 98.4, 98.6, 98.3, 98.4)
	}
	r.tick()
	if r.wakeRuns() != 1 || r.events()["wake_skipped"] != 1 {
		t.Fatalf("runs=%d events=%v", r.wakeRuns(), r.events())
	}
}

func TestNoWakeForADisabledAgentButThePlanStillApplies(t *testing.T) {
	r := newRig(t, &domain.Plan{Tripwires: []domain.Tripwire{{Kind: "adverse_atr", ATR: 1.5}}})
	r.feed.m.ATR = 1
	if err := r.st.SetEnabled(r.ctx, "a1", false); err != nil {
		t.Fatal(err)
	}
	r.bar(0, 100, 100.2, 98.3, 98.4)
	r.bar(1, 98.4, 98.5, 97.5, 97.8) // then the stop fills
	r.tick()
	if r.wakeRuns() != 0 || r.events()["wake_skipped"] != 1 || r.pos().Status != "closed" {
		t.Fatalf("runs=%d events=%v status=%s", r.wakeRuns(), r.events(), r.pos().Status)
	}
}

func TestSignalIsKnownOnlyWhenItsCandleCloses(t *testing.T) {
	r := newRig(t, &domain.Plan{Tripwires: []domain.Tripwire{{Kind: "opposite_flip"}}})
	// an M5 sell flip whose candle opens 2 minutes after the entry closes 7 minutes after it
	r.feed.m.Flips = []Event{{Time: r.base.Add(2 * time.Minute), Dir: -1}}
	for i := 0; i <= 5; i++ {
		r.bar(i, 100, 100.3, 99.7, 100)
	}
	r.tick()
	if r.wakeRuns() != 0 {
		t.Fatal("the flip candle has not closed yet; waking now would use the future")
	}
	for i := 6; i <= 9; i++ {
		r.bar(i, 100, 100.3, 99.7, 100)
	}
	r.tick()
	if r.wakeRuns() != 1 {
		t.Fatalf("the flip became known at minute 7; wakes=%d", r.wakeRuns())
	}
	// a flip in the position's own direction never wakes
	r2 := newRig(t, &domain.Plan{Tripwires: []domain.Tripwire{{Kind: "opposite_flip"}}})
	r2.feed.m.Flips = []Event{{Time: r2.base, Dir: 1}}
	for i := 0; i <= 8; i++ {
		r2.bar(i, 100, 100.3, 99.7, 100)
	}
	r2.tick()
	if r2.wakeRuns() != 0 {
		t.Fatal("a flip with the position is not a warning")
	}
}

func TestStaleFeedWakesOnceThenWaitsForBarsAgain(t *testing.T) {
	r := newRig(t, &domain.Plan{Tripwires: []domain.Tripwire{{Kind: "feed_stale", Minutes: 10}}})
	r.bar(0, 100, 100.3, 99.7, 100)
	r.tick() // one bar applied; its age at the injected clock is 29 minutes
	r.tick()
	r.tick()
	if r.wakeRuns() != 1 {
		t.Fatalf("a stale feed wakes the agent once: %d", r.wakeRuns())
	}
}
