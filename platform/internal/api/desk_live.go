package api

import (
	"context"
	"net/url"
	"sync"
	"time"
)

type liveFresh struct {
	through *time.Time
	signal  *string
	sigAt   *time.Time
	at      time.Time
}

var (
	freshMu    sync.Mutex
	freshCache = map[string]liveFresh{}
)

const freshTTL = 10 * time.Second

// engineFreshness reads the newest candle time and flip from the engine, so the Desk
// shows how current the market data is now, not when the history was imported.
func (s *Server) engineFreshness(ctx context.Context, symbol, gran string) (liveFresh, bool) {
	key := symbol + "|" + gran
	freshMu.Lock()
	c, ok := freshCache[key]
	freshMu.Unlock()
	if ok && time.Since(c.at) < freshTTL {
		return c, c.through != nil
	}
	cctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	var raw struct {
		Candles []struct {
			Time string `json:"time"`
		} `json:"candles"`
		Signals []liveSignal `json:"signals"`
	}
	if err := s.eng.Get(cctx, "/api/chart", url.Values{"instrument": {symbol}, "granularity": {gran}}, &raw); err != nil || len(raw.Candles) == 0 {
		return liveFresh{}, false
	}
	f := liveFresh{at: time.Now()}
	if t, err := time.Parse(time.RFC3339Nano, raw.Candles[len(raw.Candles)-1].Time); err == nil {
		f.through = &t
	}
	// the engine lists signals newest first; take the newest by time so the order does not matter
	for i := range raw.Signals {
		if t, err := time.Parse(time.RFC3339Nano, raw.Signals[i].Time); err == nil && (f.sigAt == nil || t.After(*f.sigAt)) {
			f.signal, f.sigAt = &raw.Signals[i].Signal, &t
		}
	}
	freshMu.Lock()
	freshCache[key] = f
	freshMu.Unlock()
	return f, f.through != nil
}

// overlayLive replaces the imported freshness fields with the engine's, in parallel.
func (s *Server) overlayLive(ctx context.Context, rows []deskRow) {
	var wg sync.WaitGroup
	for i := range rows {
		gran := ""
		for _, g := range rows[i].Granularity {
			if g == "M5" {
				gran = g
			}
		}
		if gran == "" && len(rows[i].Granularity) > 0 {
			gran = rows[i].Granularity[0]
		}
		if gran == "" {
			continue
		}
		wg.Add(1)
		go func(d *deskRow, gran string) {
			defer wg.Done()
			if f, ok := s.engineFreshness(ctx, d.Symbol, gran); ok {
				d.DataThrough, d.Live = f.through, true
				if f.signal != nil {
					d.LastSignal, d.LastSignalAt = f.signal, f.sigAt
				}
			}
		}(&rows[i], gran)
	}
	wg.Wait()
}
