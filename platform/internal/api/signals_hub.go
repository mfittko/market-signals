package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

// Browsers learn about new engine signals over the event stream, not by polling. The engine owns signals and has
// no push channel, so one shared watcher asks it while at least one browser has an instrument open, and tells every
// browser watching that instrument when its signals change. Cost does not grow with the number of browsers.
type sigHub struct {
	mu      sync.Mutex
	subs    map[*sigSub]struct{}
	running bool
	every   time.Duration
}

type sigSub struct {
	symbol string
	ch     chan string // "signal" or "news"; a full buffer drops a repeat, since the browser refetches everything
}

func newSigHub() *sigHub { return &sigHub{subs: map[*sigSub]struct{}{}, every: 5 * time.Second} }

// subscribe registers a browser for one instrument and starts the shared watcher if it is not running.
func (s *Server) subscribeSignals(symbol string) (*sigSub, func()) {
	h := s.hub
	sub := &sigSub{symbol: symbol, ch: make(chan string, 4)}
	h.mu.Lock()
	h.subs[sub] = struct{}{}
	start := !h.running
	h.running = true
	h.mu.Unlock()
	if start {
		go s.watchSignals()
	}
	return sub, func() {
		h.mu.Lock()
		delete(h.subs, sub)
		h.mu.Unlock()
	}
}

func (h *sigHub) symbols() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	seen := map[string]bool{}
	var out []string
	for sub := range h.subs {
		if !seen[sub.symbol] {
			seen[sub.symbol] = true
			out = append(out, sub.symbol)
		}
	}
	sort.Strings(out)
	return out
}

func (h *sigHub) notify(symbol, kind string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for sub := range h.subs {
		if sub.symbol == symbol {
			select {
			case sub.ch <- kind:
			default:
			}
		}
	}
}

// watchSignals runs while any browser is subscribed. The first look at an instrument sets the baseline for its
// signals and its news, and later
// changes are announced. It stops by itself when the last browser leaves.
func (s *Server) watchSignals() {
	h := s.hub
	last := map[string]string{}
	for {
		syms := h.symbols()
		if len(syms) == 0 {
			h.mu.Lock()
			if len(h.subs) == 0 {
				h.running = false
				h.mu.Unlock()
				return
			}
			h.mu.Unlock()
			continue
		}
		for _, sym := range syms {
			ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
			for kind, digest := range map[string]func(context.Context, string) (string, bool){"signal": s.signalDigest, "news": s.newsDigest} {
				d, ok := digest(ctx, sym)
				if !ok {
					continue // the engine did not answer; keep the old baseline
				}
				key := kind + "|" + sym
				if prev, seen := last[key]; seen && prev != d {
					h.notify(sym, kind)
				}
				last[key] = d
			}
			cancel()
		}
		// forget instruments nobody watches any more, so a return later starts from a fresh baseline
		live := map[string]bool{}
		for _, sym := range syms {
			live["signal|"+sym], live["news|"+sym] = true, true
		}
		for key := range last {
			if !live[key] {
				delete(last, key)
			}
		}
		time.Sleep(h.every)
	}
}

// signalDigest fingerprints the engine's current signals for an instrument on every imported timeframe.
func (s *Server) signalDigest(ctx context.Context, symbol string) (string, bool) {
	rows, err := s.st.Pool.Query(ctx, `SELECT DISTINCT granularity FROM candles WHERE instrument=$1 ORDER BY 1`, symbol)
	if err != nil {
		return "", false
	}
	var grans []string
	for rows.Next() {
		var g string
		if rows.Scan(&g) == nil {
			grans = append(grans, g)
		}
	}
	rows.Close()
	sigs, answered := s.fetchEngineSignals(ctx, symbol, grans, 0)
	if !answered {
		return "", false
	}
	lines := make([]string, 0, len(sigs))
	for _, g := range sigs {
		v := ""
		if g.Verdict != nil {
			v = *g.Verdict
		}
		lines = append(lines, fmt.Sprintf("%s|%s|%s|%s|%s", g.Granularity, g.Time, g.Kind, g.Signal, v))
	}
	sort.Strings(lines)
	sum := sha256.Sum256([]byte(strings.Join(lines, "\n")))
	return hex.EncodeToString(sum[:8]), true
}

// newsTTL is short so that a refetch right after a news notice sees the new items.
const newsTTL = 5 * time.Second

// newsDigest fingerprints the engine's news list the page shows (the last 72 hours).
func (s *Server) newsDigest(ctx context.Context, symbol string) (string, bool) {
	var out struct {
		Items []struct {
			Title string `json:"title"`
			Time  string `json:"time"`
		} `json:"items"`
	}
	q := url.Values{"instrument": {symbol}, "hours": {"72"}, "limit": {"60"}}
	if err := s.eng.GetCached(ctx, 0, "/api/news", q, &out); err != nil { // zero ttl: ask the engine and refresh the copy the page reads
		return "", false
	}
	lines := make([]string, 0, len(out.Items))
	for _, it := range out.Items {
		lines = append(lines, it.Time+"|"+it.Title)
	}
	sort.Strings(lines)
	sum := sha256.Sum256([]byte(strings.Join(lines, "\n")))
	return hex.EncodeToString(sum[:8]), true
}
