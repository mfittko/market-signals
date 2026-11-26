package main

import (
	"bytes"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"
)

func TestPullbackLoopIsOffUnlessBothVariablesAreSet(t *testing.T) {
	// the api runs in platform/ and this test in platform/cmd/api
	spec := filepath.Join("../..", pullbackSpec)
	journal := filepath.Join(t.TempDir(), "j.jsonl")
	both := map[string]string{"MS_PULLBACK_JOURNAL": journal, "MS_PULLBACK_START": "2026-12-01T00:00:00Z"}
	for name, c := range map[string]struct {
		env  map[string]string
		spec string
		on   bool
		log  string // empty means nothing is logged
	}{
		"unset":            {map[string]string{}, spec, false, ""},
		"journal only":     {map[string]string{"MS_PULLBACK_JOURNAL": "j.jsonl"}, spec, false, ""},
		"start only":       {map[string]string{"MS_PULLBACK_START": "2026-12-01T00:00:00Z"}, spec, false, ""},
		"bad start":        {map[string]string{"MS_PULLBACK_JOURNAL": journal, "MS_PULLBACK_START": "tomorrow"}, spec, false, "pullback journal off: MS_PULLBACK_START"},
		"relative journal": {map[string]string{"MS_PULLBACK_JOURNAL": "j.jsonl", "MS_PULLBACK_START": "2026-12-01T00:00:00Z"}, spec, false, "pullback journal off: MS_PULLBACK_JOURNAL must be an absolute path"},
		"missing spec":     {both, "nope.json", false, "pullback journal off: spec"},
		"both variables":   {both, spec, true, "pullback journal on"},
	} {
		var buf bytes.Buffer
		log := slog.New(slog.NewTextHandler(&buf, nil))
		getenv := func(k string) string { return c.env[k] }
		if got := pullbackLoop(getenv, c.spec, log) != nil; got != c.on {
			t.Errorf("%s: loop on = %v, want %v", name, got, c.on)
		}
		if out := buf.String(); (c.log == "" && out != "") || !strings.Contains(out, c.log) {
			t.Errorf("%s: log %q, want %q", name, out, c.log)
		}
	}
}
