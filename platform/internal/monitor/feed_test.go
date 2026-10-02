package monitor

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mfittko/market-signals/platform/internal/tools"
)

func fakeEngine(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/chart", func(w http.ResponseWriter, r *http.Request) {
		// the forming candle at 10:10 moved the quote's line to 999; the series is completed candles only
		io.WriteString(w, `{"candles":[
		  {"time":"2026-01-01T10:00:00Z","open":1,"high":2,"low":1,"close":1.5,"volume":1,"complete":true},
		  {"time":"2026-01-01T10:05:00Z","open":1,"high":2,"low":1,"close":1.6,"volume":1,"complete":true},
		  {"time":"2026-01-01T10:10:00Z","open":1,"high":2,"low":1,"close":1.7,"volume":1,"complete":false}],
		 "supertrend":[{"time":"2026-01-01T10:00:00Z","value":90},{"time":"2026-01-01T10:05:00Z","value":95}],
		 "signals":[{"time":"2026-01-01T10:00:00Z","kind":"supertrend-flip","signal":"sell"},{"time":"2026-01-01T10:05:00Z","kind":"volume-impulse","signal":""}],
		 "quote":{"last":1.7,"supertrend":{"value":999}}}`)
	})
	mux.HandleFunc("/api/indicators", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"ok":true,"indicators":{"atr14":0.42}}`)
	})
	mux.HandleFunc("/api/portfolio", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"portfolio":{"halted":true}}`)
	})
	return httptest.NewServer(mux)
}

func TestFeedReadsOnlyCompletedValues(t *testing.T) {
	srv := fakeEngine(t)
	defer srv.Close()
	m, err := EngineFeed{Eng: tools.NewEngine(srv.URL)}.Market(context.Background(), "WTICO/USD", "M5")
	if err != nil {
		t.Fatal(err)
	}
	if m.Supertrend != 95 {
		t.Fatalf("the trail must follow the line at the last completed candle (95), not the forming quote: %v", m.Supertrend)
	}
	if len(m.Bars) != 2 {
		t.Fatalf("the forming candle must not become a bar: %d", len(m.Bars))
	}
	if m.ATR != 0.42 || !m.Halted || m.Price != 1.7 {
		t.Fatalf("%+v", m)
	}
	if len(m.Flips) != 1 || m.Flips[0].Dir != -1 || len(m.Impulses) != 1 {
		t.Fatalf("flips %v impulses %v", m.Flips, m.Impulses)
	}
}

func TestCompletedSupertrendIsUnknownWithoutASeries(t *testing.T) {
	if got := completedSupertrend(chartResp{}); got != 0 {
		t.Fatalf("no series means unknown (0), got %v", got)
	}
}
