package api

import (
	"bufio"
	"context"
	"encoding/json"
	"github.com/mfittko/market-signals/platform/internal/tools"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/mfittko/market-signals/platform/internal/queue"
	"github.com/mfittko/market-signals/platform/internal/testutil"
)

func fakeEngine(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/chart", func(w http.ResponseWriter, r *http.Request) {
		// the instrument in the query must be the agent's, whatever the model asked for
		if r.URL.Query().Get("instrument") != "WTICO/USD" {
			http.Error(w, "wrong scope", 400)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{
			"candles": []map[string]any{
				{"time": "2026-01-01T10:00:00Z", "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 10}, // stored bars carry no complete field
				{"time": "2026-01-01T10:05:00Z", "open": 1.5, "high": 2, "low": 1, "close": 1.6, "volume": 5, "complete": false, "partial": true},
			},
			"signal": map[string]any{"signal": "sell", "time": "2026-01-01T09:55:00Z", "price": 1.4},
			// deliberately unordered: the Desk must pick the newest by time
			"signals":    []map[string]any{{"time": "2026-01-01T09:00:00Z", "signal": "buy"}, {"time": "2026-01-01T09:55:00Z", "signal": "sell"}, {"time": "2026-01-01T09:30:00Z", "signal": "buy"}},
			"supertrend": []map[string]any{{"value": 1.7, "trend": "down"}},
			"quote":      map[string]any{"last": 1.6, "partial": true},
			"botState":   map[string]any{"strategyRef": "s1"},
		})
	})
	mux.HandleFunc("/api/portfolio", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"portfolio": map[string]any{"equity": 1000, "cash": 900, "halted": false, "positions": []any{}}})
	})
	mux.HandleFunc("/api/news", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("instrument") != "WTICO/USD" {
			http.Error(w, "wrong scope", 400)
			return
		}
		io.WriteString(w, `{"ok":true,"items":[{"title":"Tanker hit","source":"gdelt","time":"2026-01-01T10:00:00Z","escalation":true}]}`)
	})
	mux.HandleFunc("/api/indicators", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"ok":true,"indicators":{"atr14":0.42,"extremes":{"high":99}}}`)
	})
	mux.HandleFunc("/api/settings", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"method":"`+r.Method+`","origin":"`+r.Header.Get("Origin")+`"}`)
	})
	mux.HandleFunc("/api/portfolio-secret", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, `leak`) })
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"ok":true,"feed":[{"instrument":"WTICO/USD","granularity":"M5","lastCandleTime":"2026-01-01T10:05:00.000000000Z"}]}`)
	})
	mux.HandleFunc("/api/signals", func(w http.ResponseWriter, r *http.Request) {
		// deliberately unordered: the Desk must pick the newest by time
		io.WriteString(w, `{"ok":true,"signals":[{"time":"2026-01-01T09:00:00Z","signal":"buy"},{"time":"2026-01-01T09:55:00Z","signal":"sell"}]}`)
	})
	s := httptest.NewServer(mux)
	t.Cleanup(s.Close)
	return s
}

func setup(t *testing.T) (*httptest.Server, *queue.Store) {
	t.Helper()
	st := queue.New(testutil.Pool(t))
	eng := fakeEngine(t)
	srv := New(Config{WorkerToken: "w", IngestToken: "i", EngineURL: eng.URL}, st, slog.New(slog.NewTextHandler(io.Discard, nil)))
	hs := httptest.NewServer(srv.Handler())
	t.Cleanup(hs.Close)
	ctx := context.Background()
	if err := st.UpsertAgent(ctx, queue.Agent{ID: "a1", Name: "a1", Instrument: "WTICO/USD", Granularity: "M5", Runtime: "mock",
		AllowedTools: []string{"get_snapshot", "get_recent_candles", "get_portfolio"}, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	return hs, st
}

func call(t *testing.T, method, url, token, body string, hdr map[string]string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(method, url, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	raw, _ := io.ReadAll(resp.Body)
	_ = json.Unmarshal(raw, &out)
	return resp.StatusCode, out
}

func TestWorkerAndIngestEndpointsRequireTheirTokens(t *testing.T) {
	hs, _ := setup(t)
	for _, c := range []struct{ path, token string }{
		{"/api/v1/runtime/claim", ""}, {"/api/v1/runtime/claim", "i"}, {"/api/v1/runtime/claim", "wrong"},
		{"/api/v1/events", ""}, {"/api/v1/events", "w"},
	} {
		if code, _ := call(t, "POST", hs.URL+c.path, c.token, `{}`, nil); code != 401 {
			t.Errorf("%s with token %q: got %d, want 401", c.path, c.token, code)
		}
	}
}

func TestBrowserWritesFromForeignOriginsAreRefused(t *testing.T) {
	hs, _ := setup(t)
	code, _ := call(t, "POST", hs.URL+"/api/v1/runs", "", `{"agentId":"a1","source":"demo"}`, map[string]string{"Origin": "https://evil.example"})
	if code != 403 {
		t.Fatalf("got %d", code)
	}
	code, _ = call(t, "POST", hs.URL+"/api/v1/runs", "", `{"agentId":"a1","source":"demo"}`, nil)
	if code != 202 {
		t.Fatalf("a request without an Origin header (curl, engine) must pass, got %d", code)
	}
}

func TestEngineIngestAndLegacyRoundTrip(t *testing.T) {
	hs, _ := setup(t)
	body := `{"idempotencyKey":"k1","instrument":"WTICO/USD","granularity":"M5","event":"flip","payload":{"close":1,"portfolio":{"halted":false,"positions":[]}}}`
	code, out := call(t, "POST", hs.URL+"/api/v1/events", "i", body, nil)
	if code != 202 || len(out["runs"].([]any)) != 1 {
		t.Fatalf("%d %v", code, out)
	}
	code, out = call(t, "POST", hs.URL+"/api/v1/events/k1/legacy", "i", `{"decision":{"action":"hold"}}`, nil)
	if code != 200 || out["updated"].(float64) != 1 {
		t.Fatalf("%d %v", code, out)
	}
	if code, _ = call(t, "POST", hs.URL+"/api/v1/events/nope/legacy", "i", `{}`, nil); code != 404 {
		t.Fatalf("unknown key: %d", code)
	}
}

func claimViaAPI(t *testing.T, hs *httptest.Server) (attemptID, fence float64) {
	t.Helper()
	code, out := call(t, "POST", hs.URL+"/api/v1/runtime/claim", "w", `{"workerId":"w1","runtimes":["mock"]}`, nil)
	if code != 200 {
		t.Fatalf("claim: %d %v", code, out)
	}
	a := out["attempt"].(map[string]any)
	return a["id"].(float64), a["fence"].(float64)
}

func TestToolGatewayEnforcesScopeAllowlistAndDropsProvisionalCandles(t *testing.T) {
	hs, _ := setup(t)
	call(t, "POST", hs.URL+"/api/v1/runs", "", `{"agentId":"a1","source":"demo"}`, nil)
	id, fence := claimViaAPI(t, hs)
	tool := func(name, args string) (int, map[string]any) {
		return call(t, "POST", hs.URL+"/api/v1/runtime/tools/call", "w",
			`{"attemptId":`+jn(id)+`,"fence":`+jn(fence)+`,"name":"`+name+`","args":`+args+`}`, nil)
	}
	// a model asking for another instrument still reads its own scope (fake engine 400s otherwise)
	code, out := tool("get_recent_candles", `{"count":5,"instrument":"XAU/USD"}`)
	if code != 200 || out["isError"] == true {
		t.Fatalf("%d %v", code, out)
	}
	var res struct {
		Candles []map[string]any `json:"candles"`
		Dropped int              `json:"provisionalDropped"`
	}
	if err := json.Unmarshal([]byte(out["output"].(string)), &res); err != nil {
		t.Fatal(err)
	}
	if len(res.Candles) != 1 || res.Dropped != 1 {
		t.Fatalf("the forming candle must be dropped: %+v", res)
	}
	// allowlist: get_recent_signals and a shell tool are not declared for this agent
	for _, n := range []string{"get_recent_signals", "bash", "run_sql"} {
		if code, _ := tool(n, `{}`); code != 403 {
			t.Errorf("%s must be forbidden, got %d", n, code)
		}
	}
	// wrong fence: fence_seq is global and a fresh database hands out 1, so derive a value that cannot match
	code, _ = call(t, "POST", hs.URL+"/api/v1/runtime/tools/call", "w", `{"attemptId":`+jn(id)+`,"fence":`+jn(fence+1)+`,"name":"get_snapshot","args":{}}`, nil)
	if code != 409 {
		t.Fatalf("wrong fence: %d", code)
	}
}

func jn(f float64) string { b, _ := json.Marshal(f); return string(b) }

func TestOperatorSnapshotFromEngineExcludesTheFormingCandleAndLabelsFlipAge(t *testing.T) {
	hs, st := setup(t)
	code, out := call(t, "POST", hs.URL+"/api/v1/runs", "", `{"agentId":"a1","source":"engine"}`, nil)
	if code != 202 {
		t.Fatalf("%d %v", code, out)
	}
	d, err := st.GetRun(context.Background(), int64(out["runs"].([]any)[0].(map[string]any)["runId"].(float64)))
	if err != nil {
		t.Fatal(err)
	}
	var p map[string]any
	_ = json.Unmarshal(d.Snapshot.Payload, &p)
	if p["close"].(float64) != 1.5 || p["asOf"] != "2026-01-01T10:00:00Z" {
		t.Fatalf("close/asOf must come from the last complete candle: %v", p)
	}
	if len(p["candles"].([]any)) != 1 {
		t.Fatalf("no forming candle in the snapshot: %v", p["candles"])
	}
	if q := p["quote"].(map[string]any); q["provisional"] != true {
		t.Fatalf("the live quote must be labelled provisional: %v", q)
	}
	if fl := p["flip"].(map[string]any); fl["barsAgo"].(float64) != 1 || fl["fresh"] != true {
		t.Fatalf("flip age: %v", fl)
	}
}

func TestStreamResumesFromLastEventID(t *testing.T) {
	hs, st := setup(t)
	call(t, "POST", hs.URL+"/api/v1/runs", "", `{"agentId":"a1","source":"demo"}`, nil)
	call(t, "POST", hs.URL+"/api/v1/runs", "", `{"agentId":"a1","source":"demo"}`, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", hs.URL+"/api/v1/stream", nil)
	req.Header.Set("Last-Event-ID", "1") // the client saw event 1 before it dropped
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	sc := bufio.NewScanner(resp.Body)
	var ids []string
	for sc.Scan() && len(ids) < 1 {
		if l := sc.Text(); strings.HasPrefix(l, "id: ") {
			ids = append(ids, strings.TrimPrefix(l, "id: "))
		}
	}
	if len(ids) != 1 || ids[0] != "2" {
		t.Fatalf("expected catch-up to start at event 2, got %v", ids)
	}
	_ = st
}

func TestStreamDeliversAnEventThatCommitsAfterAHigherID(t *testing.T) {
	hs, st := setup(t)
	_, out := call(t, "POST", hs.URL+"/api/v1/runs", "", `{"agentId":"a1","source":"demo"}`, nil)
	runID := int64(out["runs"].([]any)[0].(map[string]any)["runId"].(float64))
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", hs.URL+"/api/v1/stream", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	ids := make(chan int64, 16)
	go func() {
		sc := bufio.NewScanner(resp.Body)
		for sc.Scan() {
			if l := sc.Text(); strings.HasPrefix(l, "id: ") {
				n, _ := strconv.ParseInt(strings.TrimPrefix(l, "id: "), 10, 64)
				ids <- n
			}
		}
		close(ids)
	}()
	next := func() int64 {
		select {
		case n, ok := <-ids:
			if !ok {
				t.Fatal("stream closed")
			}
			return n
		case <-ctx.Done():
			t.Fatal("no event within the timeout")
		}
		return 0
	}
	ins := `INSERT INTO run_events (run_id, kind, payload) VALUES ($1, 'test', '{}') RETURNING id`
	// the slow transaction takes the lower id and holds it uncommitted
	tx, err := st.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	var low, high int64
	if err := tx.QueryRow(ctx, ins, runID).Scan(&low); err != nil {
		t.Fatal(err)
	}
	if err := st.Pool.QueryRow(ctx, ins, runID).Scan(&high); err != nil {
		t.Fatal(err)
	}
	if got := next(); got != high {
		t.Fatalf("first frame: want %d, got %d", high, got)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if got := next(); got != low {
		t.Fatalf("the late commit must still stream: want %d, got %d", low, got)
	}
}

func TestOperatorRunKeepsALongStrategyPromptUnescapedAndRefusesAnOversizedOne(t *testing.T) {
	hs, st := setup(t)
	ctx := context.Background()
	if _, err := st.Pool.Exec(ctx, `TRUNCATE strategies`); err != nil {
		t.Fatal(err)
	}
	put := func(name, prompt string) {
		t.Helper()
		if _, err := st.Pool.Exec(ctx, `INSERT INTO strategies (name,version,prompt,created_by,created_at,active,archived,dedicated) VALUES ($1,1,$2,'test',now(),true,false,false)`, name, prompt); err != nil {
			t.Fatal(err)
		}
		if c, out := call(t, "PATCH", hs.URL+"/api/v1/agents/a1", "", `{"strategy":"`+name+`"}`, nil); c != 200 {
			t.Fatalf("assign: %d %v", c, out)
		}
	}
	// a full-size prompt full of <, > and & fits once the encoder leaves them alone
	rule := "close > EMA & ADX < 25. "
	put("Symbols", strings.Repeat(rule, maxPrompt/len(rule)))
	code, out := call(t, "POST", hs.URL+"/api/v1/runs", "", `{"agentId":"a1","source":"engine"}`, nil)
	if code != 202 {
		t.Fatalf("a full-size strategy prompt must fit the snapshot: %d %v", code, out)
	}
	d, err := st.GetRun(ctx, int64(out["runs"].([]any)[0].(map[string]any)["runId"].(float64)))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(d.Snapshot.Payload), rule) {
		t.Fatal("the stored prompt must keep <, > and & as written")
	}
	// a prompt that escapes past the cap gets a clear 413
	put("Control", strings.Repeat("\x01", maxPrompt))
	code, out = call(t, "POST", hs.URL+"/api/v1/runs", "", `{"agentId":"a1","source":"engine"}`, nil)
	if code != 413 || !strings.Contains(out["error"].(string), "size limit") {
		t.Fatalf("an oversized snapshot must be a 413 with a reason: %d %v", code, out)
	}
}

func TestWithIndicatorsKeepsSymbolsUnescaped(t *testing.T) {
	s := &Server{eng: tools.NewEngine(fakeEngine(t).URL)}
	out := s.withIndicators(context.Background(), "WTICO/USD", "M5", json.RawMessage(`{"strategy":{"prompt":"close > EMA & ADX < 25"}}`))
	if !strings.Contains(string(out), "close > EMA & ADX < 25") || !strings.Contains(string(out), `"atr14"`) {
		t.Fatalf("the indicator pass must add indicators and keep <, > and & as written: %s", out)
	}
}

func TestRunChartPrefersFrozenCandlesAndFallsBackToCompleteEngineCandles(t *testing.T) {
	hs, st := setup(t)
	ctx := context.Background()
	frozen := `{"close":1,"candles":[` + strings.Repeat(`{"time":"t","open":1,"high":2,"low":1,"close":1.5,"volume":1},`, 5) + `{"time":"t","open":1,"high":2,"low":1,"close":1.5,"volume":1}]}`
	a, err := st.Ingest(ctx, queue.IngestInput{IdemKey: "c1", Instrument: "WTICO/USD", Granularity: "M5", Event: "flip", Source: "demo", Payload: json.RawMessage(frozen)})
	if err != nil {
		t.Fatal(err)
	}
	code, out := call(t, "GET", hs.URL+"/api/v1/runs/"+jn(float64(a.Runs[0].RunID))+"/chart", "", "", nil)
	if code != 200 || out["source"] != "snapshot" || len(out["candles"].([]any)) != 6 {
		t.Fatalf("%d %v", code, out)
	}
	b, err := st.Ingest(ctx, queue.IngestInput{IdemKey: "c2", Instrument: "WTICO/USD", Granularity: "M5", Event: "flip", Source: "demo", Payload: json.RawMessage(`{"close":1}`)})
	if err != nil {
		t.Fatal(err)
	}
	code, out = call(t, "GET", hs.URL+"/api/v1/runs/"+jn(float64(b.Runs[0].RunID))+"/chart", "", "", nil)
	if code != 200 || out["source"] != "engine" || len(out["candles"].([]any)) != 1 {
		t.Fatalf("the forming candle must be dropped from the live fallback: %d %v", code, out)
	}
	// outside the engine window the chart is empty with a reason, and the request still succeeds
	c, err := st.Ingest(ctx, queue.IngestInput{IdemKey: "c3", Instrument: "WTICO/USD", Granularity: "M5", Event: "flip", Source: "demo", Payload: json.RawMessage(`{"close":1,"asOf":"2020-01-01T00:00:00Z"}`)})
	if err != nil {
		t.Fatal(err)
	}
	code, out = call(t, "GET", hs.URL+"/api/v1/runs/"+jn(float64(c.Runs[0].RunID))+"/chart", "", "", nil)
	if code != 200 || len(out["candles"].([]any)) != 0 || out["reason"] == nil {
		t.Fatalf("an out-of-window snapshot must return 200 with no candles and a reason: %d %v", code, out)
	}
}

func TestChartCandlesPrefersSnapshotAndRejectsForeignMoments(t *testing.T) {
	eng := tools.NewEngine(fakeEngine(t).URL)
	ctx := context.Background()

	frozen := `{"asOf":"2020-01-01T00:00:00Z","candles":[` + strings.Repeat(`{"time":"2020-01-01T00:00:00Z","open":1,"high":2,"low":1,"close":1,"volume":1},`, 4) + `{"time":"2020-01-01T00:05:00Z","open":1,"high":2,"low":1,"close":1,"volume":1}]}`
	if c, src, _, err := chartCandles(ctx, eng, "WTICO/USD", "M5", json.RawMessage(frozen)); err != nil || src != "snapshot" || len(c) != 5 {
		t.Fatalf("frozen candles must win: %v %s %d", err, src, len(c))
	}
	// no frozen candles, asOf inside the engine window: falls back to the live window
	if _, src, _, err := chartCandles(ctx, eng, "WTICO/USD", "M5", json.RawMessage(`{"asOf":"2026-01-01T10:00:00Z"}`)); err != nil || src != "engine" {
		t.Fatalf("in-window fallback: %v %s", err, src)
	}
	// no frozen candles and a moment the live window does not cover: no candles and a reason
	if c, _, reason, err := chartCandles(ctx, eng, "WTICO/USD", "M5", json.RawMessage(`{"asOf":"2020-01-01T00:00:00Z"}`)); err != nil || len(c) != 0 || reason == "" {
		t.Fatalf("a foreign moment must not be drawn over live candles: %v %d %q", err, len(c), reason)
	}
}

func TestDeskSummarisesInstrumentsAndServesDetailBySlug(t *testing.T) {
	hs, st := setup(t)
	ctx := context.Background()
	for _, q := range []string{
		`TRUNCATE candles, signals, trades, instruments CASCADE`,
		`INSERT INTO instruments (symbol,name,market) VALUES ('WTICO/USD','WTI Oil','commodities'), ('XAU/USD','Gold','commodities')`,
		`INSERT INTO candles VALUES ('WTICO/USD','M5','2026-01-01T10:00:00Z',1,2,1,1.5,10), ('WTICO/USD','M5','2026-01-01T10:05:00Z',1.5,2,1,1.6,NULL)`,
		`INSERT INTO signals (instrument,granularity,time,kind,signal) VALUES ('WTICO/USD','M5','2026-01-01T10:00:00Z','supertrend-flip','sell')`,
		`INSERT INTO trades (source_key,position_id,instrument,side,notional,units,entry_price,entry_time,close_price,close_time,leverage,realized,close_reason)
		 VALUES ('t1',1,'WTICO/USD','long',100,1,1,now(),2,now(),20,5,'target'), ('t2',2,'WTICO/USD','long',100,1,1,now(),1,now(),20,-2,'stop')`,
	} {
		if _, err := st.Pool.Exec(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	// The mock fixture agent "a1" is hidden from the desk; only real (llm) agents are shown.
	if err := st.UpsertAgent(ctx, queue.Agent{ID: "a2", Name: "a2", Instrument: "WTICO/USD", Granularity: "M5", Runtime: "llm",
		AllowedTools: []string{"get_snapshot"}, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Ingest(ctx, queue.IngestInput{IdemKey: "desk1", Instrument: "WTICO/USD", Granularity: "M5", Event: "flip", Source: "demo", Payload: json.RawMessage(`{"close":1}`)}); err != nil {
		t.Fatal(err)
	}
	code, body := call(t, "GET", hs.URL+"/api/v1/desk", "", "", nil)
	if code != 200 {
		t.Fatalf("desk: %d %v", code, body)
	}
	rows := body["instruments"].([]any)
	if len(rows) != 2 {
		t.Fatalf("two instruments, got %d", len(rows))
	}
	wti := rows[0].(map[string]any) // the one with an enabled agent sorts first
	if wti["symbol"] != "WTICO/USD" || wti["trades"].(float64) != 2 || wti["wins"].(float64) != 1 || wti["realized"].(float64) != 3 || wti["signals"].(float64) != 1 {
		t.Fatalf("wrong summary: %v", wti)
	}
	if len(wti["agents"].([]any)) != 1 {
		t.Fatalf("the agent must appear under its instrument: %v", wti["agents"])
	}
	// the console hands lastAt to new Date(), so it must be RFC 3339
	lastAt, _ := wti["agents"].([]any)[0].(map[string]any)["lastAt"].(string)
	if _, err := time.Parse(time.RFC3339, lastAt); err != nil {
		t.Fatalf("lastAt must be RFC 3339: %q", lastAt)
	}
	// freshness comes from the engine when it answers, and the newest signal wins whatever the order
	if wti["live"] != true || wti["dataThrough"] != "2026-01-01T10:05:00Z" || wti["lastSignal"] != "sell" || wti["lastSignalAt"] != "2026-01-01T09:55:00Z" {
		t.Fatalf("wti freshness must come from the engine: %v", wti)
	}
	if gold := rows[1].(map[string]any); gold["live"] == true {
		t.Fatalf("gold has no engine data in this fixture, so it must not claim to be live: %v", gold)
	}
	code, d := call(t, "GET", hs.URL+"/api/v1/instruments/wtico-usd?granularity=M5", "", "", nil)
	if code != 200 || len(d["candles"].([]any)) != 2 || len(d["trades"].([]any)) != 2 {
		t.Fatalf("detail: %d %v", code, d)
	}
	// an alert link can name a granularity that was never imported; the response names the fallback so the page can follow it
	code, d = call(t, "GET", hs.URL+"/api/v1/instruments/wtico-usd?granularity=M15", "", "", nil)
	if code != 200 || d["granularity"] != "M5" || len(d["candles"].([]any)) != 2 {
		t.Fatalf("a granularity with no imported candles must fall back to M5 and say so: %d %v", code, d)
	}
	if code, _ := call(t, "GET", hs.URL+"/api/v1/instruments/nope", "", "", nil); code != 404 {
		t.Fatalf("unknown slug must be 404, got %d", code)
	}
}

func TestLiveAndNewsProxyTheEngineForOneInstrument(t *testing.T) {
	hs, st := setup(t)
	ctx := context.Background()
	if _, err := st.Pool.Exec(ctx, `TRUNCATE instruments CASCADE; INSERT INTO instruments (symbol,name,market) VALUES ('WTICO/USD','WTI Oil','commodities')`); err != nil {
		t.Fatal(err)
	}
	code, live := call(t, "GET", hs.URL+"/api/v1/instruments/wtico-usd/live?granularity=M5", "", "", nil)
	if code != 200 || live["source"] != "engine" {
		t.Fatalf("live: %d %v", code, live)
	}
	cs := live["candles"].([]any)
	if len(cs) != 2 || cs[0].(map[string]any)["complete"] != true || cs[1].(map[string]any)["complete"] != false {
		t.Fatalf("the forming candle must be flagged and the finished one must not: %v", cs)
	}
	code, news := call(t, "GET", hs.URL+"/api/v1/instruments/wtico-usd/news", "", "", nil)
	if code != 200 || len(news["items"].([]any)) != 1 {
		t.Fatalf("news: %d %v", code, news)
	}
	if code, _ := call(t, "GET", hs.URL+"/api/v1/instruments/nope/live", "", "", nil); code != 404 {
		t.Fatalf("unknown instrument must be 404, got %d", code)
	}
}

func TestEngineProxyAllowlist(t *testing.T) {
	ts, _ := setup(t)
	get := func(method, path string) (int, string) {
		req, _ := http.NewRequest(method, ts.URL+path, strings.NewReader("{}"))
		req.Header.Set("Origin", ts.URL)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}
	if code, body := get("POST", "/api/v1/engine/settings"); code != 200 || !strings.Contains(body, `"method":"POST"`) || strings.Contains(body, ts.URL) {
		t.Fatalf("settings not forwarded cleanly: %d %s", code, body)
	}
	for _, p := range []string{"/api/v1/engine/portfolio-secret", "/api/v1/engine/health", "/api/v1/engine/../x"} {
		if code, _ := get("GET", p); code != 404 {
			t.Fatalf("%s should be refused, got %d", p, code)
		}
	}
	// standing rules the bot reads are not a console surface
	for _, m := range []string{"GET", "POST"} {
		if code, _ := get(m, "/api/v1/engine/memories"); code != 404 {
			t.Fatalf("%s memories should be refused, got %d", m, code)
		}
	}
	if code, _ := get("DELETE", "/api/v1/engine/settings"); code != 404 {
		t.Fatalf("DELETE settings should be refused, got %d", code)
	}
	// paper bot switches, allocation and executable paths never pass through the console
	post := func(body string) int {
		req, _ := http.NewRequest("POST", ts.URL+"/api/v1/engine/settings", strings.NewReader(body))
		req.Header.Set("Origin", ts.URL)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	for _, body := range []string{
		`{"bot":{"bots":{"WTICO/USD|M5":{"enabled":true}}}}`,
		`{"bot":{"bots":{"WTICO/USD|M5":{"allocationPct":50}}}}`,
		`{"claudeBin":"/tmp/x"}`, `{"provider":"pi","piBin":"/tmp/x"}`,
		`{"notesFile":"/etc/passwd"}`,
	} {
		if code := post(body); code != http.StatusForbidden {
			t.Fatalf("%s must be refused, got %d", body, code)
		}
	}
	// the refusal names every refused key in a stable order
	for i := 0; i < 5; i++ {
		_, out := call(t, "POST", ts.URL+"/api/v1/engine/settings", "", `{"piBin":"x","bot":{},"watchers":"","notesFile":"y"}`, map[string]string{"Origin": ts.URL})
		if out["error"] != "the console may not write the engine settings bot, notesFile, piBin" {
			t.Fatalf("refusal message: %v", out["error"])
		}
	}
	// every key the console Settings page writes still passes
	for _, body := range []string{
		`{"watchers":"WTICO/USD|M5"}`,
		`{"provider":"openai","models":{"openai":"m"},"OPENAI_BASE_URL":"u","OPENAI_API_KEY":"k","ANTHROPIC_API_KEY":"k","maxCompletionTokens":100}`,
		`{"PUSHOVER_ENABLED":"1","PUSHOVER_USER":"u","PUSHOVER_TOKEN":"t"}`,
		`{"ind":"ema","freshBars":3,"impulseVolMult":2,"impulseVolWindow":20,"impulseCooldownBars":5,"filterMaxCompletionTokens":200,"keepFresh":"1","sentinelSourceFootnotes":"0","NEWSAPI_AI_MODE":"auto","GNEWS_MODE":"off"}`,
	} {
		if code := post(body); code != 200 {
			t.Fatalf("%s must still pass, got %d", body, code)
		}
	}
}

func TestEngineEventsGainIndicatorLevels(t *testing.T) {
	hs, st := setup(t)
	send := func(key, payload string) string {
		body := `{"idempotencyKey":"` + key + `","instrument":"WTICO/USD","granularity":"M5","event":"flip","payload":` + payload + `}`
		if code, out := call(t, "POST", hs.URL+"/api/v1/events", "i", body, nil); code != 202 {
			t.Fatalf("ingest: %d %v", code, out)
		}
		var got string
		if err := st.Pool.QueryRow(context.Background(), `SELECT payload->'indicators'->>'atr14' FROM snapshots WHERE idem_key=$1`, key).Scan(&got); err != nil {
			// a NULL means the key is absent
			return ""
		}
		return got
	}
	if got := send("ind-1", `{"asOf":"x"}`); got != "0.42" {
		t.Fatalf("the engine's indicator levels must be added to the snapshot, got %q", got)
	}
	// numbers the engine already supplied are never overwritten
	if got := send("ind-2", `{"indicators":{"atr14":7}}`); got != "7" {
		t.Fatalf("existing indicators must stay, got %q", got)
	}
}

func TestStrategyNamesAreUniqueIgnoringCaseAndHaveNoTrailingSpace(t *testing.T) {
	hs, st := setup(t)
	if _, err := st.Pool.Exec(context.Background(), `TRUNCATE strategies`); err != nil {
		t.Fatal(err)
	}
	save := func(name string) int {
		c, _ := call(t, "POST", hs.URL+"/api/v1/strategies/"+url.PathEscape(name)+"/versions", "", `{"prompt":"rules"}`, nil)
		return c
	}
	if c := save("Trend"); c != 200 {
		t.Fatalf("create: %d", c)
	}
	if c := save("Trend"); c != 200 {
		t.Fatalf("a new version of the same name: %d", c)
	}
	if c := save("trend"); c != 409 {
		t.Fatalf("a name differing only in case must be refused, got %d", c)
	}
	for _, bad := range []string{"Trend ", " Trend", "A "} {
		if c := save(bad); c != 400 {
			t.Fatalf("%q must be refused, got %d", bad, c)
		}
	}
	if c := save("Trend 2"); c != 200 {
		t.Fatalf("an inner space is fine: %d", c)
	}
	var n int
	if err := st.Pool.QueryRow(context.Background(), `SELECT count(DISTINCT name) FROM strategies`).Scan(&n); err != nil || n != 2 {
		t.Fatalf("strategies %d %v", n, err)
	}
}

func TestStrategyVersionsSaveActivateAndAssign(t *testing.T) {
	hs, st := setup(t)
	ctx := context.Background()
	if _, err := st.Pool.Exec(ctx, `TRUNCATE strategies`); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Pool.Exec(ctx, `INSERT INTO strategies (name,version,prompt,created_by,created_at,active,archived,instrument,granularity,dedicated)
		VALUES ('Trend',1,'v1 rules','import',now(),true,false,'WTICO/USD','M5',true)`); err != nil {
		t.Fatal(err)
	}
	// an edit adds version 2, makes it the only active one and keeps the scope of v1
	if c, out := call(t, "POST", hs.URL+"/api/v1/strategies/Trend/versions", "", `{"prompt":"  v2 rules  "}`, nil); c != 200 || out["version"] != float64(2) {
		t.Fatalf("save: %d %v", c, out)
	}
	var active int
	var inst string
	if err := st.Pool.QueryRow(ctx, `SELECT version, instrument FROM strategies WHERE name='Trend' AND active`).Scan(&active, &inst); err != nil || active != 2 || inst != "WTICO/USD" {
		t.Fatalf("active=%d inst=%q err=%v", active, inst, err)
	}
	// rollback
	if c, _ := call(t, "POST", hs.URL+"/api/v1/strategies/Trend/versions/1/activate", "", "", nil); c != 200 {
		t.Fatal(c)
	}
	var n int
	_ = st.Pool.QueryRow(ctx, `SELECT count(*) FROM strategies WHERE name='Trend' AND active AND version=1`).Scan(&n)
	if n != 1 {
		t.Fatal("v1 should be active again")
	}
	if c, _ := call(t, "POST", hs.URL+"/api/v1/strategies/Trend/versions/9/activate", "", "", nil); c != 404 {
		t.Fatalf("unknown version: %d", c)
	}
	if c, _ := call(t, "POST", hs.URL+"/api/v1/strategies/Trend/versions/abc/activate", "", "", nil); c != 404 {
		t.Fatalf("a non-numeric version must be a 404, not a server error: %d", c)
	}
	// a new name starts at version 1; bad input is refused
	if c, out := call(t, "POST", hs.URL+"/api/v1/strategies/Fresh/versions", "", `{"prompt":"x"}`, nil); c != 200 || out["version"] != float64(1) {
		t.Fatalf("new: %d %v", c, out)
	}
	if c, _ := call(t, "POST", hs.URL+"/api/v1/strategies/Trend/versions", "", `{"prompt":"  "}`, nil); c != 400 {
		t.Fatal("empty prompt must be refused")
	}
	if c, _ := call(t, "POST", hs.URL+"/api/v1/strategies/bad;name/versions", "", `{"prompt":"x"}`, nil); c != 400 {
		t.Fatal("bad name must be refused")
	}
	// history is newest first
	if c, out := call(t, "GET", hs.URL+"/api/v1/strategies/Trend", "", "", nil); c != 200 || len(out["versions"].([]any)) != 2 {
		t.Fatalf("history: %d %v", c, out)
	}
	// assign, and refuse an unknown strategy
	if c, _ := call(t, "PATCH", hs.URL+"/api/v1/agents/a1", "", `{"strategy":"Fresh"}`, nil); c != 200 {
		t.Fatal(c)
	}
	if c, _ := call(t, "PATCH", hs.URL+"/api/v1/agents/a1", "", `{"strategy":"Nope"}`, nil); c != 404 {
		t.Fatal("unknown strategy must be refused")
	}
	var got string
	_ = st.Pool.QueryRow(ctx, `SELECT strategy_name FROM agents WHERE id='a1'`).Scan(&got)
	if got != "Fresh" {
		t.Fatalf("agent strategy %q", got)
	}
}

func TestArchiveIsBlockedWhileAssignedAndReversible(t *testing.T) {
	hs, st := setup(t)
	ctx := context.Background()
	if _, err := st.Pool.Exec(ctx, `TRUNCATE strategies`); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"Old", "Live"} {
		if c, _ := call(t, "POST", hs.URL+"/api/v1/strategies/"+n+"/versions", "", `{"prompt":"x"}`, nil); c != 200 {
			t.Fatal(c)
		}
	}
	if c, _ := call(t, "PATCH", hs.URL+"/api/v1/agents/a1", "", `{"strategy":"Live"}`, nil); c != 200 {
		t.Fatal(c)
	}
	// in use: refused, nothing changes
	if c, out := call(t, "POST", hs.URL+"/api/v1/strategies/Live/archive", "", `{"archived":true}`, nil); c != 409 || out["agents"] != float64(1) {
		t.Fatalf("in use: %d %v", c, out)
	}
	// unused: archived hides it from snapshots, refuses edits and assignment, and shows in the list
	if c, _ := call(t, "POST", hs.URL+"/api/v1/strategies/Old/archive", "", `{"archived":true}`, nil); c != 200 {
		t.Fatal(c)
	}
	if c, _ := call(t, "POST", hs.URL+"/api/v1/strategies/Old/versions", "", `{"prompt":"y"}`, nil); c != 409 {
		t.Fatalf("edit of a archived strategy: %d", c)
	}
	if c, _ := call(t, "PATCH", hs.URL+"/api/v1/agents/a1", "", `{"strategy":"Old"}`, nil); c != 404 {
		t.Fatalf("assigning a archived strategy: %d", c)
	}
	// creating an agent applies the same rule: an archived or unknown strategy is refused, a live one is taken
	create := func(strategy string) int {
		c, _ := call(t, "POST", hs.URL+"/api/v1/agents", "", `{"id":"a2","instrument":"WTICO/USD","granularity":"M5","runtime":"mock","strategyName":"`+strategy+`"}`, nil)
		return c
	}
	if c := create("Old"); c != 400 {
		t.Fatalf("creating an agent on a archived strategy: %d", c)
	}
	if c := create("Nope"); c != 400 {
		t.Fatalf("creating an agent on an unknown strategy: %d", c)
	}
	if c := create("Live"); c != 200 {
		t.Fatalf("creating an agent on a live strategy: %d", c)
	}
	_, out := call(t, "GET", hs.URL+"/api/v1/strategies", "", "", nil)
	archived := map[string]bool{}
	for _, s := range out["strategies"].([]any) {
		m := s.(map[string]any)
		archived[m["name"].(string)] = m["archived"].(bool)
	}
	if !archived["Old"] || archived["Live"] {
		t.Fatalf("list: %v", archived)
	}
	// restore
	if c, _ := call(t, "POST", hs.URL+"/api/v1/strategies/Old/archive", "", `{"archived":false}`, nil); c != 200 {
		t.Fatal(c)
	}
	if c, _ := call(t, "POST", hs.URL+"/api/v1/strategies/Old/versions", "", `{"prompt":"y"}`, nil); c != 200 {
		t.Fatalf("edit after restore: %d", c)
	}
}

func TestGrillGroundsTheModelInTheTradeRecordAndRefusesBadInput(t *testing.T) {
	st := queue.New(testutil.Pool(t))
	ctx := context.Background()
	for _, q := range []string{
		`TRUNCATE trades, strategies`,
		`INSERT INTO trades (source_key,position_id,instrument,side,notional,units,entry_price,entry_time,close_price,close_time,leverage,realized,close_reason,strategy_name)
		 VALUES ('g1',1,'WTICO/USD','long',100,1,1,now(),2,now(),20,5,'target','Trend'), ('g2',2,'WTICO/USD','long',100,1,1,now(),1,now(),20,-2,'stop','Trend')`,
	} {
		if _, err := st.Pool.Exec(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	var seen []map[string]any
	srv := New(Config{WorkerToken: "w", IngestToken: "i", Complete: func(_ context.Context, m []map[string]any) (string, error) {
		seen = m
		return "Which timeframe confirms the flip?", nil
	}}, st, slog.New(slog.NewTextHandler(io.Discard, nil)))
	hs := httptest.NewServer(srv.Handler())
	defer hs.Close()

	c, out := call(t, "POST", hs.URL+"/api/v1/strategies/grill", "", `{"name":"Trend","mode":"refine","draft":"Enter on flips.","messages":[{"role":"user","content":"Start"}]}`, nil)
	if c != 200 || out["reply"] != "Which timeframe confirms the flip?" {
		t.Fatalf("%d %v", c, out)
	}
	ctxMsg := seen[1]["content"].(string)
	if !strings.Contains(ctxMsg, "2 closed trades, 1 wins") || !strings.Contains(ctxMsg, "Enter on flips.") {
		t.Fatalf("context lacks the record or the draft: %s", ctxMsg)
	}
	for _, bad := range []string{
		`{"name":"Trend","messages":[]}`,
		`{"name":"Trend","messages":[{"role":"assistant","content":"hi"}]}`,
		`{"name":"Trend","messages":[{"role":"system","content":"x"}]}`,
	} {
		if c, _ := call(t, "POST", hs.URL+"/api/v1/strategies/grill", "", bad, nil); c != 400 {
			t.Fatalf("%s: %d", bad, c)
		}
	}
	// a strategy without trades must not invite the model to cite results
	call(t, "POST", hs.URL+"/api/v1/strategies/grill", "", `{"name":"Fresh","mode":"create","messages":[{"role":"user","content":"Start"}]}`, nil)
	if !strings.Contains(seen[1]["content"].(string), "Do not cite results") {
		t.Fatal("no-record note missing")
	}
	// without a configured model the endpoint says so
	off := httptest.NewServer(New(Config{WorkerToken: "w", IngestToken: "i"}, st, slog.New(slog.NewTextHandler(io.Discard, nil))).Handler())
	defer off.Close()
	if c, _ := call(t, "POST", off.URL+"/api/v1/strategies/grill", "", `{"messages":[{"role":"user","content":"x"}]}`, nil); c != 503 {
		t.Fatalf("no model: %d", c)
	}
	// a brand new strategy keeps the scope it was created with
	if c, _ := call(t, "POST", hs.URL+"/api/v1/strategies/Scoped/versions", "", `{"prompt":"x","instrument":"XAG/USD","granularity":"H1"}`, nil); c != 200 {
		t.Fatal(c)
	}
	var in, gr string
	if err := st.Pool.QueryRow(ctx, `SELECT instrument, granularity FROM strategies WHERE name='Scoped'`).Scan(&in, &gr); err != nil || in != "XAG/USD" || gr != "H1" {
		t.Fatalf("scope %q %q %v", in, gr, err)
	}
}

func TestAgentBudgetsOutsideTheirBoundsAreRefused(t *testing.T) {
	hs, st := setup(t)
	agent := func(budgets string) string {
		return `{"id":"b1","instrument":"WTICO/USD","granularity":"M5","runtime":"mock","budgets":` + budgets + `}`
	}
	// a deadline past int4 would break the reaper's cast for every agent; an attempt count past it breaks ingest
	for _, b := range []string{`{"deadlineSeconds":3000000000}`, `{"maxAttempts":2147483648}`, `{"leaseSeconds":-1}`, `{"maxToolCalls":1000}`} {
		if c, out := call(t, "POST", hs.URL+"/api/v1/agents", "", agent(b), nil); c != 400 || !strings.Contains(out["error"].(string), "budget") {
			t.Fatalf("%s: %d %v", b, c, out)
		}
	}
	if c, out := call(t, "POST", hs.URL+"/api/v1/agents", "", agent(`{"deadlineSeconds":3600,"maxAttempts":2}`), nil); c != 200 {
		t.Fatalf("in-range budgets: %d %v", c, out)
	}
	var deadline int
	if err := st.Pool.QueryRow(context.Background(), `SELECT (budgets->>'deadlineSeconds')::int FROM agents WHERE id='b1'`).Scan(&deadline); err != nil || deadline != 3600 {
		t.Fatalf("stored deadline %d %v", deadline, err)
	}
}

func TestGrillAcceptsATrimmedWindowAndLongCoachRepliesAsHistory(t *testing.T) {
	st := queue.New(testutil.Pool(t))
	var seen []map[string]any
	srv := New(Config{WorkerToken: "w", IngestToken: "i", Complete: func(_ context.Context, m []map[string]any) (string, error) {
		seen = m
		return "next", nil
	}}, st, slog.New(slog.NewTextHandler(io.Discard, nil)))
	hs := httptest.NewServer(srv.Handler())
	defer hs.Close()
	// a full revised prompt fits the coach reply, so the reply fed back as history is larger than it
	longReply := `{"prompt":"` + strings.Repeat("Enter on flips. ", maxPrompt/16) + `","summary":"rewritten","question":"Anything else?"}`
	// 30 messages cut from an alternating interview start on a coach turn
	var msgs []chatMsg
	for i := 0; i < 30; i++ {
		role, content := "assistant", "coach turn"
		if i%2 == 1 {
			role, content = "user", "answer"
		}
		if i == 2 {
			content = longReply
		}
		msgs = append(msgs, chatMsg{Role: role, Content: content})
	}
	body, _ := json.Marshal(map[string]any{"name": "Trend", "mode": "refine", "draft": "x", "messages": msgs})
	if c, out := call(t, "POST", hs.URL+"/api/v1/strategies/grill", "", string(body), nil); c != 200 {
		t.Fatalf("%d %v", c, out)
	}
	if seen[2]["role"] != "user" || len(seen) != 2+29 {
		t.Fatalf("history must open on the user turn: %v, %d messages", seen[2]["role"], len(seen))
	}
}

func TestGrillTurnParsingKeepsOneRecommendationAndTolerantOfFences(t *testing.T) {
	raw := "Sure!\n```json\n" + `{"question":"How far should the stop sit?","why":"Losses average larger than wins.",
	 "options":[{"label":"1.0 ATR","recommended":true},{"label":"1.5 ATR","recommended":true},{"label":"","detail":"dropped"},{"label":"2 ATR"}],
	 "recommendation":"Take 1.0 ATR."}` + "\n```"
	tr := parseTurn(raw)
	if tr == nil || tr.Question != "How far should the stop sit?" {
		t.Fatalf("%+v", tr)
	}
	rec := 0
	for _, o := range tr.Options {
		if o.Label == "" {
			t.Fatal("an option without a label must be dropped")
		}
		if o.Recommended {
			rec++
		}
	}
	if len(tr.Options) != 3 || rec != 1 || !tr.Options[0].Recommended {
		t.Fatalf("options %+v", tr.Options)
	}
	for _, bad := range []string{"plain prose", "{not json}", `{"why":"only a why"}`} {
		if parseTurn(bad) != nil {
			t.Fatalf("%q should not parse", bad)
		}
	}
	if p := parseTurn(`{"prompt":"Enter on flips.","summary":"tightened"}`); p == nil || p.Prompt == "" {
		t.Fatal("a prompt-only turn is valid")
	}
}

func TestGrillTurnMarksTheOptionNamedInTheRecommendation(t *testing.T) {
	tr := parseTurn(`{"question":"q","options":[{"label":"A one"},{"label":"B two"}],"recommendation":"Take 'B two' because it is simpler."}`)
	if tr == nil || tr.Options[0].Recommended || !tr.Options[1].Recommended {
		t.Fatalf("%+v", tr)
	}
}

func TestAutoGrillBacktestsFlipsAndNeedsEnoughHistory(t *testing.T) {
	st := queue.New(testutil.Pool(t))
	ctx := context.Background()
	for _, q := range []string{
		`TRUNCATE candles, signals`,
		// a noisy uptrend: 600 five-minute bars
		`INSERT INTO candles SELECT 'T/USD','M5', TIMESTAMPTZ '2026-01-01T00:00:00Z' + i*interval '5 minutes',
		   100+i*0.05+sin(i)*0.5, 100+i*0.05+sin(i)*0.5+0.8, 100+i*0.05+sin(i)*0.5-0.8, 100+i*0.05+sin(i+1)*0.5, 100+(i%7)*10
		 FROM generate_series(0,599) i`,
		`INSERT INTO signals (instrument,granularity,time,kind,signal)
		 SELECT 'T/USD','M5', TIMESTAMPTZ '2026-01-01T00:00:00Z' + i*interval '5 minutes','supertrend-flip', CASE WHEN i%2=0 THEN 'buy' ELSE 'sell' END
		 FROM generate_series(50,560,6) i`,
	} {
		if _, err := st.Pool.Exec(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	srv := New(Config{WorkerToken: "w", IngestToken: "i", Complete: func(_ context.Context, m []map[string]any) (string, error) {
		if !strings.Contains(m[1]["content"].(string), "Backtest evidence for T/USD M5") {
			t.Errorf("the coach must receive the evidence: %v", m[1]["content"])
		}
		return `{"recommendation":"Keep the baseline.","prompt":"Enter on flips.","summary":"none"}`, nil
	}}, st, slog.New(slog.NewTextHandler(io.Discard, nil)))
	hs := httptest.NewServer(srv.Handler())
	defer hs.Close()

	c, out := call(t, "POST", hs.URL+"/api/v1/strategies/autogrill", "", `{"name":"x","instrument":"T/USD","granularity":"M5","draft":"d"}`, nil)
	if c != 200 {
		t.Fatalf("%d %v", c, out)
	}
	bt := out["backtest"].(map[string]any)
	if bt["tried"] != float64(192) || bt["flips"] != float64(86) || len(bt["caveats"].([]any)) != 3 {
		t.Fatalf("backtest %v", bt)
	}
	if out["turn"].(map[string]any)["prompt"] != "Enter on flips." {
		t.Fatalf("turn %v", out["turn"])
	}
	// no history: refused with the reason, before any model call
	if c, out := call(t, "POST", hs.URL+"/api/v1/strategies/autogrill", "", `{"instrument":"NOPE","granularity":"M5"}`, nil); c != 422 || !strings.Contains(out["error"].(string), "not enough history") {
		t.Fatalf("%d %v", c, out)
	}
	// without a model the backtest still runs
	off := httptest.NewServer(New(Config{WorkerToken: "w", IngestToken: "i"}, st, slog.New(slog.NewTextHandler(io.Discard, nil))).Handler())
	defer off.Close()
	if c, out := call(t, "POST", off.URL+"/api/v1/strategies/autogrill", "", `{"instrument":"T/USD","granularity":"M5"}`, nil); c != 200 || out["turn"] != nil || out["backtest"] == nil {
		t.Fatalf("no model: %d %v", c, out)
	}
}

func TestPositionsEndpoints(t *testing.T) {
	ts, st := setup(t)
	_ = st
	for _, p := range []string{"/api/v1/positions", "/api/v1/positions?status=open"} {
		resp, err := http.Get(ts.URL + p)
		if err != nil || resp.StatusCode != 200 {
			t.Fatalf("%s: %v %v", p, resp, err)
		}
		resp.Body.Close()
	}
	resp, _ := http.Get(ts.URL + "/api/v1/positions/999999")
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown position: got %d", resp.StatusCode)
	}
	resp.Body.Close()
}

// A DNS-rebinding page controls its Origin and its Host, so the two matching proves nothing.
// The Host itself must be a name the server serves.
func TestRebindingHostIsRefusedEvenWhenOriginMatches(t *testing.T) {
	hs, _ := setup(t)
	for _, method := range []string{"GET", "POST"} {
		req, _ := http.NewRequest(method, hs.URL+"/api/v1/engine/settings", strings.NewReader(`{"OPENAI_BASE_URL":"https://attacker.example"}`))
		req.Host = "attacker.example:8080"
		req.Header.Set("Origin", "http://attacker.example:8080")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Fatalf("%s with a foreign Host must be refused, got %d", method, resp.StatusCode)
		}
	}
	// the console proxy keeps Host on loopback and forwards the page host in X-Forwarded-Host
	for fwd, want := range map[string]int{"attacker.example:3000": http.StatusForbidden, "localhost:3000": 200} {
		req, _ := http.NewRequest("GET", hs.URL+"/api/v1/health", nil)
		req.Host = "127.0.0.1:8080"
		req.Header.Set("X-Forwarded-Host", fwd)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != want {
			t.Fatalf("forwarded host %q: got %d, want %d", fwd, resp.StatusCode, want)
		}
	}
	for _, host := range []string{"localhost:8080", "127.0.0.1:8080", "[::1]:8080"} {
		req, _ := http.NewRequest("GET", hs.URL+"/api/v1/health", nil)
		req.Host = host
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("loopback host %q must pass, got %d", host, resp.StatusCode)
		}
	}
}

func TestAgentScopeMustUseTheEngineShapes(t *testing.T) {
	hs, _ := setup(t)
	agent := func(inst, gran string) string {
		return `{"id":"s1","instrument":"` + inst + `","granularity":"` + gran + `","runtime":"mock"}`
	}
	for _, g := range []string{"M5", "H4", "M10"} {
		if c, out := call(t, "POST", hs.URL+"/api/v1/agents", "", agent("WTICO/USD", g), nil); c != 200 {
			t.Fatalf("%s: %d %v", g, c, out)
		}
	}
	for _, bad := range [][2]string{{"WTICO/USD", "5m"}, {"WTICO/USD", "M"}, {"WTICO/USD", "m5"}, {"WTICO/USD", "D1"}, {"WTICO/USD", "M100"}, {"WTICO/USD", ""}, {"WTI USD", "M5"}, {"W", "M5"}} {
		if c, _ := call(t, "POST", hs.URL+"/api/v1/agents", "", agent(bad[0], bad[1]), nil); c != 400 {
			t.Fatalf("%v must be refused, got %d", bad, c)
		}
	}
	// a new strategy's scope follows the same rules
	if c, _ := call(t, "POST", hs.URL+"/api/v1/strategies/Scoped2/versions", "", `{"prompt":"x","instrument":"XAG/USD","granularity":"5m"}`, nil); c != 400 {
		t.Fatalf("bad strategy scope: %d", c)
	}
}

func TestRunWithAnUnknownSourceIsRefused(t *testing.T) {
	hs, _ := setup(t)
	for _, src := range []string{"dem", "Demo", "live"} {
		if c, _ := call(t, "POST", hs.URL+"/api/v1/runs", "", `{"agentId":"a1","source":"`+src+`"}`, nil); c != 400 {
			t.Fatalf("%q must be refused, got %d", src, c)
		}
	}
}

func TestAnImportedStrategyWithOneArchivedOldVersionStaysEditable(t *testing.T) {
	hs, st := setup(t)
	if _, err := st.Pool.Exec(context.Background(), `TRUNCATE strategies;
		INSERT INTO strategies (name,version,prompt,created_by,created_at,active,archived,dedicated) VALUES
		  ('Mixed',1,'old','import',now(),false,true,false), ('Mixed',2,'live','import',now(),true,false,false)`); err != nil {
		t.Fatal(err)
	}
	if c, out := call(t, "POST", hs.URL+"/api/v1/strategies/Mixed/versions", "", `{"prompt":"v3"}`, nil); c != 200 || out["version"] != float64(3) {
		t.Fatalf("save: %d %v", c, out)
	}
}

func TestAPromptAtTheLimitFitsTheBodyWhateverItsEscaping(t *testing.T) {
	hs, _ := setup(t)
	// control characters are the worst case: JSON writes each one as six bytes
	body := func(n int) string {
		b, _ := json.Marshal(map[string]string{"prompt": "a" + strings.Repeat("\x01", n-2) + "a"})
		return string(b)
	}
	if c, out := call(t, "POST", hs.URL+"/api/v1/strategies/Escaped/versions", "", body(maxPrompt), nil); c != 200 {
		t.Fatalf("at the limit: %d %v", c, out)
	}
	if c, out := call(t, "POST", hs.URL+"/api/v1/strategies/Escaped/versions", "", body(maxPrompt+1), nil); c != 413 {
		t.Fatalf("over the limit must be the prompt message: %d %v", c, out)
	}
	draft, _ := json.Marshal(map[string]string{"instrument": "WTICO/USD", "granularity": "M5", "draft": strings.Repeat("\x01", maxPrompt+1)})
	if c, out := call(t, "POST", hs.URL+"/api/v1/strategies/autogrill", "", string(draft), nil); c != 400 || out["error"] == nil || !strings.Contains(out["error"].(string), "draft is over") {
		t.Fatalf("an escaped draft over the limit must get the draft message: %d %v", c, out)
	}
}

func TestGrillTurnMarksTheLongestOptionNamedInTheRecommendation(t *testing.T) {
	tr := parseTurn(`{"question":"q","options":[{"label":"2 ATR"},{"label":"1.2 ATR"}],"recommendation":"Take 1.2 ATR."}`)
	if tr == nil || tr.Options[0].Recommended || !tr.Options[1].Recommended {
		t.Fatalf("%+v", tr)
	}
	// two labels of the same length named in the text leave the pick to the trader
	tr = parseTurn(`{"question":"q","options":[{"label":"1 ATR"},{"label":"2 ATR"}],"recommendation":"Between 1 ATR and 2 ATR."}`)
	if tr == nil || tr.Options[0].Recommended || tr.Options[1].Recommended {
		t.Fatalf("%+v", tr)
	}
}

// The launchd console serves on 3737 and its proxy forwards the browser Origin unchanged,
// so a write from it passes only when that exact host:port is allowed.
func TestConsoleOriginOnOtherPortNeedsAnAllowlistEntry(t *testing.T) {
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	for _, c := range []struct {
		origins []string
		want    int
	}{
		{[]string{"localhost:3000", "127.0.0.1:3000"}, http.StatusForbidden},
		{[]string{"localhost:3000", "127.0.0.1:3000", "localhost:3737", "127.0.0.1:3737"}, http.StatusOK},
	} {
		s := &Server{cfg: Config{AllowedOrigins: c.origins}}
		req := httptest.NewRequest("POST", "http://127.0.0.1:8080/api/v1/runs", strings.NewReader(`{}`))
		req.Header.Set("Origin", "http://127.0.0.1:3737")
		rec := httptest.NewRecorder()
		s.originGuard(ok).ServeHTTP(rec, req)
		if rec.Code != c.want {
			t.Fatalf("origins %q: got %d, want %d", c.origins, rec.Code, c.want)
		}
	}
}
