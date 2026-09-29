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
				{"time": "2026-01-01T10:00:00Z", "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 10, "complete": true},
				{"time": "2026-01-01T10:05:00Z", "open": 1.5, "high": 2, "low": 1, "close": 1.6, "volume": 5, "complete": false, "partial": true},
			},
			"signal":     map[string]any{"signal": "sell", "time": "2026-01-01T09:55:00Z", "price": 1.4},
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
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, `{"ok":true}`) })
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
	// wrong fence
	code, _ = call(t, "POST", hs.URL+"/api/v1/runtime/tools/call", "w", `{"attemptId":`+jn(id)+`,"fence":1,"name":"get_snapshot","args":{}}`, nil)
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
}

func TestChartCandlesPrefersSnapshotAndRejectsForeignMoments(t *testing.T) {
	eng := tools.NewEngine(fakeEngine(t).URL)
	ctx := context.Background()

	frozen := `{"asOf":"2020-01-01T00:00:00Z","candles":[` + strings.Repeat(`{"time":"2020-01-01T00:00:00Z","open":1,"high":2,"low":1,"close":1,"volume":1},`, 4) + `{"time":"2020-01-01T00:05:00Z","open":1,"high":2,"low":1,"close":1,"volume":1}]}`
	if c, src, err := chartCandles(ctx, eng, "WTICO/USD", "M5", json.RawMessage(frozen)); err != nil || src != "snapshot" || len(c) != 5 {
		t.Fatalf("frozen candles must win: %v %s %d", err, src, len(c))
	}
	// no frozen candles, asOf inside the engine window: falls back to the live window
	if _, src, err := chartCandles(ctx, eng, "WTICO/USD", "M5", json.RawMessage(`{"asOf":"2026-01-01T10:00:00Z"}`)); err != nil || src != "engine" {
		t.Fatalf("in-window fallback: %v %s", err, src)
	}
	// no frozen candles and a moment the live window does not cover: refuse, do not mislead
	if _, _, err := chartCandles(ctx, eng, "WTICO/USD", "M5", json.RawMessage(`{"asOf":"2020-01-01T00:00:00Z"}`)); err == nil {
		t.Fatal("a foreign moment must not be drawn over live candles")
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
	code, d := call(t, "GET", hs.URL+"/api/v1/instruments/wtico-usd?granularity=M5", "", "", nil)
	if code != 200 || len(d["candles"].([]any)) != 2 || len(d["trades"].([]any)) != 2 {
		t.Fatalf("detail: %d %v", code, d)
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
	if code, _ := get("DELETE", "/api/v1/engine/settings"); code != 404 {
		t.Fatalf("DELETE settings should be refused, got %d", code)
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
