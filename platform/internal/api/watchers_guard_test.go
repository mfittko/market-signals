package api

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// engineWith fakes an engine whose settings and portfolio answer as given; an empty string answers 500.
func engineWith(t *testing.T, settings, portfolio string) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	serve := func(body string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if body == "" {
				http.Error(w, "down", 500)
				return
			}
			io.WriteString(w, body)
		}
	}
	mux.HandleFunc("/api/settings", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			io.WriteString(w, `{"ok":true}`)
			return
		}
		serve(settings)(w, r)
	})
	mux.HandleFunc("/api/portfolio", serve(portfolio))
	s := httptest.NewServer(mux)
	t.Cleanup(s.Close)
	return s
}

func postWatchers(t *testing.T, eng *httptest.Server, watchers string) (int, string) {
	t.Helper()
	srv := New(Config{EngineURL: eng.URL}, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	hs := httptest.NewServer(srv.Handler())
	t.Cleanup(hs.Close)
	code, out := call(t, "POST", hs.URL+"/api/v1/engine/settings", "", `{"watchers":"`+watchers+`"}`, map[string]string{"Origin": hs.URL})
	msg, _ := out["error"].(string)
	return code, msg
}

const twoPairs = `"watchers":"WTICO/USD|M5, XAU/USD|H1"`

func TestWatcherRemovalIsRefusedWhileTheBotIsEnabled(t *testing.T) {
	eng := engineWith(t, `{`+twoPairs+`,"bot":{"enabled":true}}`, `{"portfolio":{"positions":[]}}`)
	code, msg := postWatchers(t, eng, "WTICO/USD|M5")
	if code != http.StatusConflict || !strings.Contains(msg, "paper bot is on") {
		t.Fatalf("removal with the bot on must be refused: %d %q", code, msg)
	}
}

func TestWatcherRemovalIsRefusedWhenTheBotStateIsUnreadable(t *testing.T) {
	for name, eng := range map[string]*httptest.Server{
		"settings":  engineWith(t, ``, `{"portfolio":{"positions":[]}}`),
		"portfolio": engineWith(t, `{`+twoPairs+`,"bot":{"enabled":false}}`, ``),
	} {
		if code, msg := postWatchers(t, eng, "WTICO/USD|M5"); code != http.StatusConflict || msg == "" {
			t.Fatalf("%s unreadable must refuse: %d %q", name, code, msg)
		}
	}
}

func TestWatcherRemovalIsRefusedWithAnOpenPositionOnThatInstrument(t *testing.T) {
	eng := engineWith(t, `{`+twoPairs+`,"bot":{"enabled":false}}`, `{"portfolio":{"positions":[{"instrument":"XAU/USD"}]}}`)
	if code, msg := postWatchers(t, eng, "WTICO/USD|M5"); code != http.StatusConflict || !strings.Contains(msg, "XAU/USD") {
		t.Fatalf("removal with an open position must be refused: %d %q", code, msg)
	}
	if code, _ := postWatchers(t, eng, "XAU/USD|H1"); code != 200 {
		t.Fatalf("removing a pair with no position must pass: %d", code)
	}
}

func TestWatcherRemovalIsAllowedWhenTheBotIsOffAndHoldsNothing(t *testing.T) {
	eng := engineWith(t, `{`+twoPairs+`,"bot":{"enabled":false}}`, `{"portfolio":{"positions":[]}}`)
	if code, msg := postWatchers(t, eng, "WTICO/USD|M5"); code != 200 {
		t.Fatalf("removal with the bot off and no position must pass: %d %q", code, msg)
	}
}

// The engine keeps the case of an instrument and defaults the timeframe to M5 only when an
// entry has no separator, so the guard must read the list the same way.
func TestWatcherGuardReadsEntriesTheWayTheEngineDoes(t *testing.T) {
	eng := engineWith(t, `{`+twoPairs+`,"bot":{"enabled":true}}`, `{"portfolio":{"positions":[]}}`)
	cases := []struct {
		name, posted string
		refused      bool
	}{
		{"a changed case names another pair", "wtico/usd|M5, XAU/USD|H1", true},
		{"a missing timeframe means M5", "WTICO/USD, XAU/USD|H1", false},
		{"an empty timeframe after the separator is not M5", "WTICO/USD|, XAU/USD|H1", true},
		{"spaces around parts are ignored", " WTICO/USD | M5 , XAU/USD|H1", false},
	}
	for _, c := range cases {
		code, msg := postWatchers(t, eng, c.posted)
		if c.refused != (code == http.StatusConflict) {
			t.Fatalf("%s: refused=%v but got %d %q", c.name, c.refused, code, msg)
		}
	}
}

func TestWatcherAdditionIsAlwaysAllowed(t *testing.T) {
	eng := engineWith(t, `{`+twoPairs+`,"bot":{"enabled":true}}`, ``)
	if code, msg := postWatchers(t, eng, "WTICO/USD|M5, XAU/USD|H1, BTC/USD|M5"); code != 200 {
		t.Fatalf("an addition must pass even with the bot on: %d %q", code, msg)
	}
}
