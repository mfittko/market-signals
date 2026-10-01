package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

// The engine runs the paper bot only for watched pairs, so dropping a pair stops the
// bot's stop and target fills on its open positions. The console may add pairs freely.
// It may remove one only when the bot is off and holds nothing on that instrument.

// normPair mirrors how the engine reads a watcher entry: parts are trimmed, case is kept,
// and the timeframe defaults to M5 only when the entry has no separator at all. Changing
// the case of an instrument therefore names a different pair, which the engine would not
// match to any candles or positions.
func normPair(p string) string {
	a, b, hasTF := strings.Cut(p, "|")
	if !hasTF {
		b = "M5"
	}
	return strings.TrimSpace(a) + "|" + strings.TrimSpace(b)
}

func pairSet(csv string) map[string]bool {
	out := map[string]bool{}
	for _, p := range strings.Split(csv, ",") {
		if strings.TrimSpace(p) != "" {
			out[normPair(p)] = true
		}
	}
	return out
}

func (s *Server) engineGetJSON(ctx context.Context, path string, out any) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(s.cfg.EngineURL, "/")+path, nil)
	if err != nil {
		return err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return errors.New("engine answered " + res.Status)
	}
	return json.NewDecoder(res.Body).Decode(out)
}

// watcherRemovalRefusal returns a message when the posted watcher list would drop a
// pair the paper bot depends on, or when the bot state cannot be read. "" means allowed.
func (s *Server) watcherRemovalRefusal(ctx context.Context, posted json.RawMessage) string {
	var next string
	if json.Unmarshal(posted, &next) != nil {
		return "the watcher list must be a text value"
	}
	var cur struct {
		Watchers string `json:"watchers"`
		Bot      struct {
			Enabled bool `json:"enabled"`
			Bots    map[string]struct {
				Enabled bool `json:"enabled"`
			} `json:"bots"`
		} `json:"bot"`
	}
	if err := s.engineGetJSON(ctx, "/api/settings", &cur); err != nil {
		return "The alert list was not changed: the engine settings could not be read."
	}
	posts := pairSet(next)
	var removed []string
	for p := range pairSet(cur.Watchers) {
		if !posts[p] {
			removed = append(removed, p)
		}
	}
	if len(removed) == 0 {
		return ""
	}
	botOn := cur.Bot.Enabled
	for _, b := range cur.Bot.Bots {
		botOn = botOn || b.Enabled
	}
	if botOn {
		return "Signal alerts stay on while the paper bot is on, because the bot trades only watched pairs. Turn the bot off in the engine's own settings page first."
	}
	var pf struct {
		Portfolio struct {
			Positions []struct {
				Instrument string `json:"instrument"`
			} `json:"positions"`
		} `json:"portfolio"`
	}
	if err := s.engineGetJSON(ctx, "/api/portfolio", &pf); err != nil {
		return "The alert list was not changed: the paper bot's open positions could not be read."
	}
	for _, r := range removed {
		inst, _, _ := strings.Cut(r, "|")
		for _, p := range pf.Portfolio.Positions {
			// A case-folded match errs towards refusing, which is the safe side.
			if strings.EqualFold(strings.TrimSpace(p.Instrument), inst) {
				return "Signal alerts stay on for " + inst + " while the paper bot holds an open position there, because the bot needs the pair watched to close it."
			}
		}
	}
	return ""
}
