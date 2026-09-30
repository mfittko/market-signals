package api

import (
	"context"
	"net/url"
	"sync"
	"time"
)

// The imported signal history stops at the import. The instrument page also asks the engine for its current
// signals (at most 40 per timeframe), one small call per timeframe, so the list keeps up with new flips and verdicts.

// engineSignals returns the engine's newest signals for every timeframe of an instrument.
// A timeframe the engine cannot answer contributes nothing, and the imported rows still show.
func (s *Server) engineSignals(ctx context.Context, symbol string, grans []string) []liveSignal {
	// the whole fan-out gets 3 seconds, so a slow engine cannot stall the page
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	var mu sync.Mutex
	var wg sync.WaitGroup
	var out []liveSignal
	for _, gran := range grans {
		wg.Add(1)
		go func(gran string) {
			defer wg.Done()
			var raw struct {
				Signals []liveSignal `json:"signals"`
			}
			q := url.Values{"instrument": {symbol}, "granularity": {gran}, "limit": {"40"}}
			if err := s.eng.GetCached(ctx, 5*time.Second, "/api/signals", q, &raw); err != nil {
				return
			}
			mu.Lock()
			out = append(out, raw.Signals...)
			mu.Unlock()
		}(gran)
	}
	wg.Wait()
	return out
}

// signalKey identifies one signal row: the same bar and kind on the same timeframe is the same row,
// whichever source it came from.
func signalKey(gran string, t time.Time, kind string) string {
	return gran + "|" + t.UTC().Format(time.RFC3339Nano) + "|" + kind
}
