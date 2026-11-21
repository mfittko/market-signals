package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/mfittko/market-signals/platform/internal/domain"
	"github.com/mfittko/market-signals/platform/internal/monitor"
	"github.com/mfittko/market-signals/platform/internal/queue"
	"github.com/mfittko/market-signals/platform/internal/testutil"
)

// nodeEvent is the payload the Node engine posts: its strategy, and the advisory context nested under context.
const nodeEvent = `{"instrument":"WTICO/USD","granularity":"M5","event":"flip","asOf":"2026-01-01T10:00:00Z","close":100,
	"quote":{"last":100,"provisional":false},"flip":{"signal":"buy","price":100,"time":"2026-01-01T10:00:00Z","reason":null,"barsAgo":0},
	"volumeImpulse":null,"trend":"up","supertrend":99,"backtest":null,
	"strategy":{"name":"engine-trend","version":"v7","dbVersion":3,"prompt":"engine rules"},
	"portfolio":{"equity":10000,"cash":10000,"halted":false,"positions":[]},
	"context":{"traderMemories":null,"sentinel":null,"axisGate":{"verdict":"pass"}}}`

type ruleRig struct {
	t   *testing.T
	ctx context.Context
	hs  *httptest.Server
	st  *queue.Store
	srv *Server
}

func newRuleRig(t *testing.T) *ruleRig {
	t.Helper()
	st := queue.New(testutil.Pool(t))
	ctx := context.Background()
	if _, err := st.Pool.Exec(ctx, `TRUNCATE strategies`); err != nil {
		t.Fatal(err)
	}
	srv := New(Config{WorkerToken: "w", IngestToken: "i", EngineURL: fakeEngine(t).URL}, st, slog.New(slog.NewTextHandler(io.Discard, nil)))
	hs := httptest.NewServer(srv.Handler())
	t.Cleanup(hs.Close)
	return &ruleRig{t: t, ctx: ctx, hs: hs, st: st, srv: srv}
}

func (r *ruleRig) strategy(name string, version int, prompt string) {
	r.t.Helper()
	if _, err := r.st.Pool.Exec(r.ctx, `INSERT INTO strategies (name,version,prompt,created_by,created_at,active,archived,dedicated) VALUES ($1,$2,$3,'test',now(),true,false,false)`, name, version, prompt); err != nil {
		r.t.Fatal(err)
	}
}

func (r *ruleRig) agent(id, strategy string) {
	r.t.Helper()
	if err := r.st.UpsertAgent(r.ctx, queue.Agent{ID: id, Name: id, Instrument: "WTICO/USD", Granularity: "M5", Runtime: "mock", StrategyName: strategy,
		AllowedTools: []string{"get_snapshot"}, Enabled: true}); err != nil {
		r.t.Fatal(err)
	}
}

func (r *ruleRig) event(key string) (int, map[string]any) {
	r.t.Helper()
	return call(r.t, "POST", r.hs.URL+"/api/v1/events", "i", `{"idempotencyKey":"`+key+`","instrument":"WTICO/USD","granularity":"M5","event":"flip","payload":`+nodeEvent+`}`, nil)
}

// claim takes the next queued run and returns it with the payload the worker sees.
func (r *ruleRig) claim() (*queue.Claim, map[string]any) {
	r.t.Helper()
	c, err := r.st.Claim(r.ctx, "w", []string{"mock"}, 30*time.Second)
	if err != nil || c == nil {
		r.t.Fatal("claim", err)
	}
	var p map[string]any
	if err := json.Unmarshal(c.Snapshot.Payload, &p); err != nil {
		r.t.Fatal(err)
	}
	return c, p
}

type wakeFeed struct{ m monitor.Market }

func (f *wakeFeed) Market(context.Context, string, string) (monitor.Market, error) { return f.m, nil }

// entryThenWake ingests one engine event, opens a position from its run, fires an
// adverse-ATR tripwire through the position monitor and claims the wake run.
func (r *ruleRig) entryThenWake(key string) (entry, wake map[string]any) {
	r.t.Helper()
	if code, out := r.event(key); code != 202 {
		r.t.Fatalf("ingest: %d %v", code, out)
	}
	c, entry := r.claim()
	tgt := 106.0
	plan := &domain.Plan{Tripwires: []domain.Tripwire{{Kind: "adverse_atr", ATR: 1.5}}}
	if _, err := r.st.Complete(r.ctx, c.Attempt.ID, c.Attempt.Fence, queue.CompleteInput{Proposal: &domain.Decision{Action: "open", Side: "long", Notional: 1000, Stop: 98, Target: &tgt, Plan: plan}}); err != nil {
		r.t.Fatal(err)
	}
	ps, err := r.st.ListPositions(r.ctx, "open", 1)
	if err != nil || len(ps) == 0 {
		r.t.Fatal("no open position", err)
	}
	base := ps[0].EntryTime.Truncate(time.Minute).Add(time.Minute)
	feed := &wakeFeed{m: monitor.Market{ATR: 1, Bars: []monitor.Bar{{Time: base, Open: 100, High: 100.2, Low: 98.3, Close: 98.4, Volume: 10}}}}
	mon := &monitor.Service{Store: r.st, Feed: feed, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Now: func() time.Time { return base.Add(30 * time.Minute) },
		Enrich: r.srv.WakeEnricher()}
	if err := mon.Tick(r.ctx); err != nil {
		r.t.Fatal(err)
	}
	wc, wake := r.claim()
	if wc.Snapshot.Source != "monitor" {
		r.t.Fatalf("the second claim must be the wake: %+v", wc.Snapshot)
	}
	return entry, wake
}

func TestEngineEventAndWakeRunUnderTheSameConsoleStrategy(t *testing.T) {
	r := newRuleRig(t)
	r.strategy("Trend", 1, "console rules")
	r.agent("a1", "Trend")
	entry, wake := r.entryThenWake("e-1")
	want := map[string]any{"name": "Trend", "version": float64(1), "prompt": "console rules"}
	if !reflect.DeepEqual(entry["strategy"], want) {
		t.Fatalf("the engine-event run must run under the console strategy: %v", entry["strategy"])
	}
	if !reflect.DeepEqual(wake["strategy"], entry["strategy"]) {
		t.Fatalf("the wake must run under the strategy the entry ran under: entry %v, wake %v", entry["strategy"], wake["strategy"])
	}
	// the engine's strategy is recorded beside it, as a reference
	for _, p := range []map[string]any{entry, wake} {
		es, _ := p["engineStrategy"].(map[string]any)
		if es["name"] != "engine-trend" || es["prompt"] != nil {
			t.Fatalf("engineStrategy must name the engine's strategy without its prompt: %v", p["engineStrategy"])
		}
	}
	// the Node context moved to top level
	if _, nested := entry["context"]; nested || entry["axisGate"] == nil {
		t.Fatalf("context fields must be top level: %v", entry)
	}
}

func TestTwoAgentsOnOneEngineEventEachGetTheirOwnStrategy(t *testing.T) {
	r := newRuleRig(t)
	r.strategy("Trend", 1, "trend rules")
	r.strategy("Fade", 4, "fade rules")
	r.agent("a1", "Trend")
	r.agent("a2", "Fade")
	if code, out := r.event("e-2"); code != 202 || len(out["runs"].([]any)) != 2 {
		t.Fatalf("ingest: %d %v", code, out)
	}
	got := map[string]any{}
	snaps := map[int64]bool{}
	for range 2 {
		c, p := r.claim()
		got[c.Agent.ID] = p["strategy"]
		snaps[c.Snapshot.ID] = true
	}
	if len(snaps) != 1 {
		t.Fatalf("both runs must share one snapshot row: %v", snaps)
	}
	want := map[string]any{
		"a1": map[string]any{"name": "Trend", "version": float64(1), "prompt": "trend rules"},
		"a2": map[string]any{"name": "Fade", "version": float64(4), "prompt": "fade rules"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("each agent must get its own strategy: %v", got)
	}
}

func TestTheStrategyIsFrozenWhenTheRunIsEnqueued(t *testing.T) {
	r := newRuleRig(t)
	r.strategy("Trend", 1, "v1 rules")
	r.agent("a1", "Trend")
	code, out := r.event("e-3")
	if code != 202 {
		t.Fatalf("ingest: %d %v", code, out)
	}
	if c, out := call(t, "POST", r.hs.URL+"/api/v1/strategies/Trend/versions", "", `{"prompt":"v2 rules","baseVersion":1}`, nil); c != 200 {
		t.Fatalf("save v2: %d %v", c, out)
	}
	c, p := r.claim()
	if st, _ := p["strategy"].(map[string]any); st["version"] != float64(1) || st["prompt"] != "v1 rules" {
		t.Fatalf("the run must keep the version from enqueue time: %v", p["strategy"])
	}
	// get_snapshot reads the same governed payload the claim returned
	tc, err := r.st.AuthorizeTool(r.ctx, c.Attempt.ID, c.Attempt.Fence, "get_snapshot", nil)
	if err != nil {
		t.Fatal(err)
	}
	if string(tc.Snapshot.Payload) != string(c.Snapshot.Payload) {
		t.Fatalf("get_snapshot payload differs from the claim:\n%s\n%s", tc.Snapshot.Payload, c.Snapshot.Payload)
	}
	// the run API names the frozen strategy without repeating its prompt
	d, err := r.st.GetRun(r.ctx, c.Run.ID)
	if err != nil {
		t.Fatal(err)
	}
	var ref map[string]any
	if err := json.Unmarshal(d.Run.Strategy, &ref); err != nil || ref["name"] != "Trend" || ref["version"] != float64(1) || ref["prompt"] != nil {
		t.Fatalf("run strategy: %s %v", d.Run.Strategy, err)
	}
}

func TestAnAgentWithoutAConsoleStrategyKeepsTheEnginesOnEveryPath(t *testing.T) {
	r := newRuleRig(t)
	r.agent("a1", "")
	entry, wake := r.entryThenWake("e-4")
	engine := map[string]any{"name": "engine-trend", "version": "v7", "dbVersion": float64(3), "prompt": "engine rules"}
	if !reflect.DeepEqual(entry["strategy"], engine) || !reflect.DeepEqual(wake["strategy"], engine) {
		t.Fatalf("the engine's strategy must govern entry and wake: entry %v, wake %v", entry["strategy"], wake["strategy"])
	}
	if entry["engineStrategy"] == nil || wake["engineStrategy"] == nil {
		t.Fatal("engineStrategy must be recorded on both runs")
	}
	// the operator path labels the engine's bot strategy the same way
	if code, out := call(t, "POST", r.hs.URL+"/api/v1/runs", "", `{"agentId":"a1","source":"engine"}`, nil); code != 202 {
		t.Fatalf("operator run: %d %v", code, out)
	}
	c, op := r.claim()
	if !reflect.DeepEqual(op["strategy"], map[string]any{"name": "s1"}) || op["engineStrategy"] == nil {
		t.Fatalf("the operator run must keep the engine's strategy: %v", op)
	}
	if d, err := r.st.GetRun(r.ctx, c.Run.ID); err != nil || d.Run.Strategy != nil {
		t.Fatalf("a run without a console strategy freezes none: %s %v", d.Run.Strategy, err)
	}
}

func TestALongStrategyPromptIsRefusedOnTheEnginePath(t *testing.T) {
	r := newRuleRig(t)
	// each control byte escapes to six, so the frozen strategy is far over the cap
	r.strategy("Long", 1, strings.Repeat("\x01", maxPrompt))
	r.agent("a1", "Long")
	code, out := r.event("e-5")
	if code != 413 || !strings.Contains(out["error"].(string), "size limit") || out["hint"] == nil {
		t.Fatalf("an oversized payload with its strategy must be a 413 with a hint: %d %v", code, out)
	}
	var n int
	if err := r.st.Pool.QueryRow(r.ctx, `SELECT count(*) FROM snapshots WHERE idem_key='e-5'`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("a refused event must store nothing: %d %v", n, err)
	}
}

func TestEngineEventSnapshotMovesContextUpAndRenamesTheStrategy(t *testing.T) {
	var p map[string]any
	if err := json.Unmarshal(engineEventSnapshot("WTICO/USD", "M5", "flip", json.RawMessage(nodeEvent)), &p); err != nil {
		t.Fatal(err)
	}
	if _, has := p["context"]; has {
		t.Fatal("context must be gone")
	}
	if _, has := p["strategy"]; has {
		t.Fatal("the stored snapshot carries the engine's strategy as engineStrategy only")
	}
	if p["axisGate"].(map[string]any)["verdict"] != "pass" || p["engineStrategy"].(map[string]any)["prompt"] != "engine rules" {
		t.Fatalf("mapped payload: %v", p)
	}
	// fields outside the shared set stay as sent
	if _, has := p["backtest"]; !has || p["trend"] != "up" {
		t.Fatalf("engine-only fields must stay: %v", p)
	}
	if got := engineEventSnapshot("X", "M5", "flip", json.RawMessage(`[1]`)); string(got) != `[1]` {
		t.Fatalf("a non-object payload passes unchanged: %s", got)
	}
}
