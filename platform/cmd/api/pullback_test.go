package main

import (
	"log/slog"
	"path/filepath"
	"testing"
)

func TestPullbackLoopIsOffUnlessBothVariablesAreSet(t *testing.T) {
	// the api runs in platform/ and this test in platform/cmd/api
	spec := filepath.Join("../..", pullbackSpec)
	log := slog.New(slog.DiscardHandler)
	both := map[string]string{"MS_PULLBACK_JOURNAL": "j.jsonl", "MS_PULLBACK_START": "2026-12-01T00:00:00Z"}
	for name, c := range map[string]struct {
		env  map[string]string
		spec string
		on   bool
	}{
		"unset":          {map[string]string{}, spec, false},
		"journal only":   {map[string]string{"MS_PULLBACK_JOURNAL": "j.jsonl"}, spec, false},
		"start only":     {map[string]string{"MS_PULLBACK_START": "2026-12-01T00:00:00Z"}, spec, false},
		"bad start":      {map[string]string{"MS_PULLBACK_JOURNAL": "j.jsonl", "MS_PULLBACK_START": "tomorrow"}, spec, false},
		"missing spec":   {both, "nope.json", false},
		"both variables": {both, spec, true},
	} {
		getenv := func(k string) string { return c.env[k] }
		if got := pullbackLoop(getenv, c.spec, log) != nil; got != c.on {
			t.Errorf("%s: loop on = %v, want %v", name, got, c.on)
		}
	}
}
