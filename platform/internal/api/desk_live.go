package api

import (
	"context"
	"net/url"
	"sync"
	"time"
)

// The Desk shows how current the market data is now, not when the history was imported.
// It asks the engine two cheap questions: one health call lists the newest candle of every
// watched pair, and one small signals call per instrument gives its latest flip. The full
// chart payload (about 50 KB and half a second per instrument) is left to the instrument page.

const freshTTL = 10 * time.Second

type feedCache struct {
	at         time.Time
	m          map[string]time.Time // "SYMBOL|GRAN" -> newest candle time
	refreshing bool
}

type sigCache struct {
	at     time.Time
	signal *string
	sigAt  *time.Time
}

var (
	freshMu   sync.Mutex
	feedByEng = map[string]feedCache{}
	sigByKey  = map[string]sigCache{}
)

// watchedFeed returns the newest candle time per watched pair. Unwatched pairs are
// absent: the engine keeps no fresher data for them than the imported history.
// Past its ttl the last answer is still returned at once and refreshed in the
// background, so a slow engine call never holds up a page load.
func (s *Server) watchedFeed(ctx context.Context) map[string]time.Time {
	freshMu.Lock()
	c, ok := feedByEng[s.eng.BaseURL]
	if ok && time.Since(c.at) < freshTTL {
		freshMu.Unlock()
		return c.m
	}
	if ok {
		if !c.refreshing {
			c.refreshing = true
			feedByEng[s.eng.BaseURL] = c
			go func() { s.storeFeed(context.Background()) }()
		}
		freshMu.Unlock()
		return c.m
	}
	freshMu.Unlock()
	return s.storeFeed(ctx)
}

func (s *Server) storeFeed(ctx context.Context) map[string]time.Time {
	cctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	var raw struct {
		Feed []struct {
			Instrument     string `json:"instrument"`
			Granularity    string `json:"granularity"`
			LastCandleTime string `json:"lastCandleTime"`
		} `json:"feed"`
	}
	if err := s.eng.Get(cctx, "/api/health", nil, &raw); err != nil {
		freshMu.Lock()
		defer freshMu.Unlock()
		c := feedByEng[s.eng.BaseURL]
		c.refreshing = false
		feedByEng[s.eng.BaseURL] = c
		return c.m
	}
	m := map[string]time.Time{}
	for _, f := range raw.Feed {
		if t, err := time.Parse(time.RFC3339Nano, f.LastCandleTime); err == nil {
			m[f.Instrument+"|"+f.Granularity] = t
		}
	}
	freshMu.Lock()
	feedByEng[s.eng.BaseURL] = feedCache{at: time.Now(), m: m}
	freshMu.Unlock()
	return m
}

// latestSignal reads the newest flip for one instrument and granularity.
func (s *Server) latestSignal(ctx context.Context, symbol, gran string) (*string, *time.Time) {
	key := s.eng.BaseURL + "|" + symbol + "|" + gran
	freshMu.Lock()
	c, ok := sigByKey[key]
	freshMu.Unlock()
	if ok {
		if time.Since(c.at) >= freshTTL {
			// serve the last answer now; the bumped time keeps other requests from refetching
			freshMu.Lock()
			c.at = time.Now().Add(-freshTTL + time.Second)
			sigByKey[key] = c
			freshMu.Unlock()
			go s.fetchSignal(context.Background(), key, symbol, gran)
		}
		return c.signal, c.sigAt
	}
	return s.fetchSignal(ctx, key, symbol, gran)
}

func (s *Server) fetchSignal(ctx context.Context, key, symbol, gran string) (*string, *time.Time) {
	cctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	var raw struct {
		Signals []liveSignal `json:"signals"`
	}
	if err := s.eng.Get(cctx, "/api/signals", url.Values{"instrument": {symbol}, "granularity": {gran}, "limit": {"1"}}, &raw); err != nil {
		return nil, nil
	}
	c := sigCache{at: time.Now()}
	// take the newest by time, so the engine's ordering does not matter
	for i := range raw.Signals {
		if t, err := time.Parse(time.RFC3339Nano, raw.Signals[i].Time); err == nil && (c.sigAt == nil || t.After(*c.sigAt)) {
			c.signal, c.sigAt = &raw.Signals[i].Signal, &t
		}
	}
	freshMu.Lock()
	sigByKey[key] = c
	freshMu.Unlock()
	return c.signal, c.sigAt
}

// overlayLive replaces the imported freshness fields with the engine's, in parallel.
// M5 is preferred when it is watched, otherwise the first watched granularity.
func (s *Server) overlayLive(ctx context.Context, rows []deskRow) {
	feed := s.watchedFeed(ctx)
	if len(feed) == 0 {
		return
	}
	var wg sync.WaitGroup
	for i := range rows {
		gran := ""
		if _, ok := feed[rows[i].Symbol+"|M5"]; ok {
			gran = "M5"
		} else {
			for _, g := range rows[i].Granularity {
				if _, ok := feed[rows[i].Symbol+"|"+g]; ok {
					gran = g
					break
				}
			}
		}
		if gran == "" {
			continue
		}
		through := feed[rows[i].Symbol+"|"+gran]
		wg.Add(1)
		go func(d *deskRow, gran string, through time.Time) {
			defer wg.Done()
			d.DataThrough, d.Live = &through, true
			if sig, at := s.latestSignal(ctx, d.Symbol, gran); sig != nil {
				d.LastSignal, d.LastSignalAt = sig, at
			}
		}(&rows[i], gran, through)
	}
	wg.Wait()
}
