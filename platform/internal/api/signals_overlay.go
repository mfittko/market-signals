package api

import (
	"context"
	"net/url"
	"sync"
	"time"
)

// The imported signal history stops at the import. The instrument page also asks the engine for its current
// signals (at most 40 per timeframe), one small call per timeframe, so the list keeps up with new flips and verdicts.

// fetchEngineSignals returns the engine's newest signals for every timeframe of an instrument, and whether every
// timeframe answered. A ttl of zero always asks the engine and refreshes the cached copy. The whole fan-out gets 3 seconds, so a slow engine cannot
// stall the caller.
func (s *Server) fetchEngineSignals(ctx context.Context, symbol string, grans []string, ttl time.Duration) ([]liveSignal, bool) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	var mu sync.Mutex
	var wg sync.WaitGroup
	var out []liveSignal
	all := true
	for _, gran := range grans {
		wg.Add(1)
		go func(gran string) {
			defer wg.Done()
			var raw struct {
				Signals []liveSignal `json:"signals"`
			}
			q := url.Values{"instrument": {symbol}, "granularity": {gran}, "limit": {"40"}}
			var err error
			// a zero ttl always asks the engine and stores the answer, so the page's cached read sees what the hub saw
			err = s.eng.GetCached(ctx, ttl, "/api/signals", q, &raw)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				all = false
				return
			}
			out = append(out, raw.Signals...)
		}(gran)
	}
	wg.Wait()
	return out, all
}

// engineSignals is the cached read for the instrument page. A timeframe the engine cannot answer contributes
// nothing, and the imported rows still show.
func (s *Server) engineSignals(ctx context.Context, symbol string, grans []string, ttl time.Duration) []liveSignal {
	out, _ := s.fetchEngineSignals(ctx, symbol, grans, ttl)
	return out
}

// signalKey identifies one signal row: the same bar and kind on the same timeframe is the same row,
// whichever source it came from.
func signalKey(gran string, t time.Time, kind string) string {
	return gran + "|" + t.UTC().Format(time.RFC3339Nano) + "|" + kind
}
