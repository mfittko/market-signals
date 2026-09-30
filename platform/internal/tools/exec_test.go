package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mfittko/market-signals/platform/internal/queue"
)

func toolEnv(t *testing.T) (*Engine, *queue.ToolContext, *[]string) {
	t.Helper()
	var seen []string
	mux := http.NewServeMux()
	mux.HandleFunc("/api/portfolio", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"portfolio":{"equity":1000,"cash":900,"halted":false,"unrealized":5,"positions":[{"id":3,"instrument":"WTICO/USD","side":"long","secret":"drop me"}]}}`))
	})
	mux.HandleFunc("/api/chart", func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.URL.Query().Get("instrument")+"|"+r.URL.Query().Get("granularity"))
		// stored history carries no complete field, as the engine serves it
		w.Write([]byte(`{"candles":[
			{"time":"t1","open":1,"high":2,"low":1,"close":1.5,"volume":10},
			{"time":"t2","open":1.5,"high":2,"low":1,"close":1.6,"volume":11},
			{"time":"t3","open":1.6,"high":2,"low":1,"close":1.7,"volume":5,"complete":false,"partial":true}]}`))
	})
	mux.HandleFunc("/api/signals", func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, "signals limit="+r.URL.Query().Get("limit"))
		w.Write([]byte(`{"signals":[{"time":"t1","signal":"buy"}]}`))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	tc := &queue.ToolContext{}
	tc.Snapshot.Instrument, tc.Snapshot.Granularity = "WTICO/USD", "M5"
	return NewEngine(srv.URL), tc, &seen
}

func TestReadToolsAreScopedToTheSnapshotAndTrimTheirOutput(t *testing.T) {
	eng, tc, seen := toolEnv(t)
	ctx := context.Background()

	out, err := Exec(ctx, eng, nil, 0, 0, tc, "get_portfolio", nil)
	if err != nil || strings.Contains(out, "drop me") || !strings.Contains(out, `"equity":1000`) {
		t.Fatalf("portfolio must keep only the allowed position fields: %v %s", err, out)
	}

	// the model asks for another instrument; the snapshot's scope wins
	out, err = Exec(ctx, eng, nil, 0, 0, tc, "get_recent_candles", json.RawMessage(`{"count":1,"instrument":"XAU/USD"}`))
	if err != nil {
		t.Fatal(err)
	}
	var c struct {
		Candles            []map[string]any `json:"candles"`
		ProvisionalDropped int              `json:"provisionalDropped"`
	}
	if err := json.Unmarshal([]byte(out), &c); err != nil || len(c.Candles) != 1 || c.Candles[0]["time"] != "t2" || c.ProvisionalDropped != 1 {
		t.Fatalf("only the newest complete candle, and the forming one dropped: %v %+v", err, c)
	}
	if (*seen)[0] != "WTICO/USD|M5" {
		t.Fatalf("scope must come from the snapshot, got %v", *seen)
	}

	if _, err := Exec(ctx, eng, nil, 0, 0, tc, "get_recent_signals", json.RawMessage(`{"limit":500}`)); err != nil {
		t.Fatal(err)
	}
	if (*seen)[1] != "signals limit=20" {
		t.Fatalf("the limit must be clamped to 20, got %v", *seen)
	}
}

func TestUnknownToolAndBadFollowupArgumentsAreErrors(t *testing.T) {
	eng, tc, _ := toolEnv(t)
	if _, err := Exec(context.Background(), eng, nil, 0, 0, tc, "rm_rf", nil); err == nil {
		t.Fatal("an unknown tool must be an error")
	}
	if _, err := Exec(context.Background(), eng, nil, 0, 0, tc, "schedule_followup", json.RawMessage(`{"seconds":"soon"}`)); err == nil {
		t.Fatal("bad arguments must be an error before any store call")
	}
}

func TestEngineFailureIsReturnedNotSwallowed(t *testing.T) {
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "x", 500) }))
	defer down.Close()
	tc := &queue.ToolContext{}
	if _, err := Exec(context.Background(), NewEngine(down.URL), nil, 0, 0, tc, "get_portfolio", nil); err == nil {
		t.Fatal("an engine error must reach the model as a tool error")
	}
	if _, err := Exec(context.Background(), &Engine{}, nil, 0, 0, tc, "get_portfolio", nil); err == nil {
		t.Fatal("an unconfigured engine must be an error")
	}
}

func TestClampIntAndDefinitions(t *testing.T) {
	for _, c := range []struct {
		args string
		want int
	}{{`{"n":5}`, 5}, {`{"n":0}`, 1}, {`{"n":999}`, 20}, {`{}`, 10}, {`not json`, 10}} {
		if got := clampInt(json.RawMessage(c.args), "n", 10, 1, 20); got != c.want {
			t.Fatalf("%s: got %d want %d", c.args, got, c.want)
		}
	}
	names := map[string]bool{}
	for _, d := range Definitions() {
		names[d.Name] = true
		if d.Description == "" || d.InputSchema["type"] != "object" {
			t.Fatalf("incomplete definition: %+v", d)
		}
	}
	for _, want := range []string{"get_snapshot", "get_portfolio", "get_recent_candles", "get_recent_signals", "schedule_followup"} {
		if !names[want] {
			t.Fatalf("missing tool %s", want)
		}
	}
}

func TestRecentCandlesStayValidJSONWithTheNewestBarAtTheMaximumCount(t *testing.T) {
	var sb strings.Builder
	sb.WriteString(`{"candles":[`)
	for i := 0; i < 200; i++ {
		if i > 0 {
			sb.WriteString(",")
		}
		fmt.Fprintf(&sb, `{"time":"2026-01-01T09:00:00.123456789Z#%03d","open":71.123456,"high":72.123456,"low":70.123456,"close":71.5,"volume":123456}`, i)
	}
	sb.WriteString(`]}`)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(sb.String())) }))
	defer srv.Close()
	tc := &queue.ToolContext{}
	tc.Snapshot.Instrument, tc.Snapshot.Granularity = "WTICO/USD", "M5"
	out, err := Exec(context.Background(), NewEngine(srv.URL), nil, 0, 0, tc, "get_recent_candles", json.RawMessage(`{"count":120}`))
	if err != nil {
		t.Fatal(err)
	}
	var c struct {
		Candles []map[string]any `json:"candles"`
	}
	if err := json.Unmarshal([]byte(out), &c); err != nil || len(c.Candles) == 0 {
		t.Fatalf("output must be valid JSON with candles: %v %.80s", err, out)
	}
	if last := c.Candles[len(c.Candles)-1]["time"]; !strings.HasSuffix(last.(string), "#199") {
		t.Fatalf("newest candle must be kept, got %v", last)
	}
}
