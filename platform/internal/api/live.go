package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// lookupSymbol resolves a URL slug to its instrument symbol.
func (s *Server) lookupSymbol(r *http.Request) (string, bool) {
	return s.symbolForSlug(r.Context(), r.PathValue("slug"))
}

type liveCandle struct {
	Time     string  `json:"time"`
	Open     float64 `json:"open"`
	High     float64 `json:"high"`
	Low      float64 `json:"low"`
	Close    float64 `json:"close"`
	Volume   float64 `json:"volume"`
	Complete bool    `json:"complete"`
}

type liveSignal struct {
	Time        string   `json:"time"`
	Granularity string   `json:"granularity"`
	Kind        string   `json:"kind"`
	Signal      string   `json:"signal"`
	Price       *float64 `json:"price"`
	Verdict     *string  `json:"verdict"`
	Reason      *string  `json:"reason"`
}

// live returns the engine's current chart window for one instrument: candles
// with the forming one flagged, the Supertrend line, signals and the quote.
// The console polls it. It is read-only here; the engine owns the data.
func (s *Server) live(w http.ResponseWriter, r *http.Request) {
	symbol, ok := s.lookupSymbol(r)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "unknown instrument"})
		return
	}
	gran := r.URL.Query().Get("granularity")
	if gran == "" {
		gran = "M5"
	}
	var raw struct {
		Candles []struct {
			liveCandle
			CompleteP *bool `json:"complete"`
		} `json:"candles"`
		Supertrend []struct {
			Time  string  `json:"time"`
			Value float64 `json:"value"`
			Trend string  `json:"trend"`
		} `json:"supertrend"`
		Signals []liveSignal   `json:"signals"`
		Quote   map[string]any `json:"quote"`
	}
	q := url.Values{"instrument": {symbol}, "granularity": {gran}}
	if err := s.eng.GetCached(r.Context(), 5*time.Second, "/api/chart", q, &raw); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error(), "hint": "the engine is not reachable; showing imported history only"})
		return
	}
	candles := make([]liveCandle, 0, len(raw.Candles))
	for _, c := range raw.Candles {
		c.liveCandle.Complete = c.CompleteP == nil || *c.CompleteP // complete unless the engine says otherwise
		candles = append(candles, c.liveCandle)
	}
	if len(candles) > 150 {
		candles = candles[len(candles)-150:]
	}
	first := ""
	if len(candles) > 0 {
		first = candles[0].Time
	}
	st := make([]map[string]any, 0, len(raw.Supertrend))
	for _, p := range raw.Supertrend {
		if p.Time >= first {
			st = append(st, map[string]any{"time": p.Time, "value": p.Value, "trend": p.Trend})
		}
	}
	sigs := make([]liveSignal, 0, len(raw.Signals))
	for _, g := range raw.Signals {
		if g.Time >= first {
			sigs = append(sigs, g)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"source": "engine", "symbol": symbol, "granularity": gran, "fetchedAt": time.Now().UTC().Format(time.RFC3339),
		"candles": candles, "supertrend": st, "signals": sigs, "quote": raw.Quote,
	})
}

// news proxies the engine's cached headlines for one instrument.
func (s *Server) news(w http.ResponseWriter, r *http.Request) {
	symbol, ok := s.lookupSymbol(r)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "unknown instrument"})
		return
	}
	hours := 24
	if n, err := strconv.Atoi(r.URL.Query().Get("hours")); err == nil && n >= 1 && n <= 336 {
		hours = n
	}
	var out json.RawMessage
	q := url.Values{"instrument": {symbol}, "hours": {strconv.Itoa(hours)}, "limit": {"60"}}
	if err := s.eng.GetCached(r.Context(), time.Minute, "/api/news", q, &out); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error(), "hint": "the engine is not reachable, so news cannot be read"})
		return
	}
	w.Header().Set("content-type", "application/json")
	_, _ = w.Write(out)
}

// symbolForSlug maps a URL slug such as wtico-usd to the instrument symbol.
func (s *Server) symbolForSlug(ctx context.Context, slug string) (string, bool) {
	var symbol string
	err := s.st.Pool.QueryRow(ctx, `SELECT symbol FROM instruments WHERE replace(lower(symbol),'/','-')=$1`, strings.ToLower(slug)).Scan(&symbol)
	return symbol, err == nil
}
