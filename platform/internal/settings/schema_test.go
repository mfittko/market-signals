package settings

import (
	"errors"
	"slices"
	"strings"
	"testing"
)

func TestCheck(t *testing.T) {
	cases := []struct {
		o     Origin
		key   string
		val   any
		error string // "" means accepted
	}{
		{FromAPI, "port", float64(8787), ""},
		{FromAPI, "port", "8787", "must be an integer"},
		{FromAPI, "port", float64(0), "must be an integer"},
		{FromAPI, "nope", "x", "unknown settings key"},
		{FromAPI, "provider", "gpt", "must be one of"},
		{FromAPI, "keepFresh", "1", ""},
		{FromAPI, "keepFresh", "yes", "must be true"},
		{FromAPI, "NEWSAPI_AI_REQUEST_BUDGET", "500", ""},
		{FromAPI, "cycleMinutes", map[string]any{"M5": float64(5)}, ""},
		{FromAPI, "cycleMinutes", map[string]any{"5m": float64(5)}, "granularity"},
		{FromAPI, "OPENAI_BASE_URL", "https://api.example.test/v1", ""},
		{FromAPI, "OPENAI_BASE_URL", "https://u:p@api.example.test/v1", "credentials"},
		{FromAPI, "bot", map[string]any{"bots": map[string]any{"WTICO/USD|M5": map[string]any{"enabled": true, "riskPct": float64(1)}}}, ""},
		{FromAPI, "bot", map[string]any{"bots": map[string]any{"WTICO/USD|M5": map[string]any{"enabled": "yes"}}}, "enabled must be true"},
		{FromAPI, "bot", map[string]any{"resetHalt": true}, "unknown key bot.resetHalt"},
		// paths: refused over HTTP, by key or by value, and accepted from the import
		{FromAPI, "piBin", "/opt/homebrew/bin/pi", "path is not accepted"},
		{FromAPI, "piBin", nil, "path is not accepted"},
		{FromImport, "piBin", "/opt/homebrew/bin/pi", ""},
		{FromAPI, "model", "/usr/bin/env", "path is not accepted"},
		{FromAPI, "sttModel", "../../etc/passwd", "path is not accepted"},
		{FromAPI, "models", map[string]any{"pi": "~/bin/model"}, "path is not accepted"},
		{FromAPI, "model", "openai/gpt-5", ""},
		{FromAPI, "model", "gpt-5", ""},
		{FromAPI, "model", "FILE:///etc/passwd", "path is not accepted"},
		{FromAPI, "model", " /usr/bin/env", "path is not accepted"},
		// a traversal segment after the first character is a path too
		{FromAPI, "model", "x/../../etc/passwd", "path is not accepted"},
		{FromAPI, "model", "openai/../../../bin/sh", "path is not accepted"},
		{FromAPI, "model", "openai/..", "path is not accepted"},
		{FromAPI, "model", "..", "path is not accepted"},
		// the engine accepts any integer strategy id, so the import does too
		{FromImport, "bot", map[string]any{"bots": map[string]any{"WTICO/USD|M5": map[string]any{"enabled": true, "strategyId": float64(0)}}}, ""},
		{FromImport, "bot", map[string]any{"bots": map[string]any{"WTICO/USD|M5": map[string]any{"strategyId": float64(-3)}}}, ""},
		{FromImport, "bot", map[string]any{"bots": map[string]any{"WTICO/USD|M5": map[string]any{"strategyId": float64(1.5)}}}, "must be an integer"},
		// a path used as a map key is refused like a path value
		{FromAPI, "bot", map[string]any{"leverage": map[string]any{"/etc/passwd": float64(2)}}, "path is not accepted"},
		{FromAPI, "bot", map[string]any{"bots": map[string]any{"/etc/passwd|M5": map[string]any{"enabled": false}}}, "path is not accepted"},
		{FromAPI, "bot", map[string]any{"leverage": map[string]any{"XAU/USD": float64(2)}, "bots": map[string]any{"XAU/USD|H1": map[string]any{"enabled": false}}}, ""},
		// a null per-combo entry is the engine's merge-delete marker, not data
		{FromAPI, "bot", map[string]any{"bots": map[string]any{"XAU/USD|H1": nil}}, "[XAU/USD|H1] must be an object"},
		// a secret is an opaque token: a leading slash is not a path
		{FromAPI, "TYPESAFE_API_KEY", "/aB3-fake-token", ""},
		// job owner flags: operator route only
		{FromAPI, "jobOwner.bot", "go", "operator route"},
		{FromImport, "jobOwner.bot", "go", "operator route"},
		{FromOperator, "jobOwner.bot", "go", ""},
		{FromOperator, "jobOwner.bot", "rust", "must be one of"},
		{FromOperator, "port", float64(1), "only job owner flags"},
		// model spend cap and price table
		{FromAPI, "llmDailyCapUsd", float64(5), ""},
		{FromAPI, "llmDailyCapUsd", float64(1000), ""},
		{FromAPI, "llmDailyCapUsd", float64(0), "must be a number above 0"},
		{FromAPI, "llmDailyCapUsd", float64(1000.01), "must be a number above 0"},
		{FromAPI, "llmDailyCapUsd", "5", "must be a number above 0"},
		{FromAPI, "llmModelPrices", map[string]any{"glm-5": map[string]any{"inputPerMTok": float64(1), "outputPerMTok": float64(3.2)}}, ""},
		{FromAPI, "llmModelPrices", map[string]any{"free": map[string]any{"inputPerMTok": float64(0), "outputPerMTok": float64(0)}}, ""},
		{FromAPI, "llmModelPrices", map[string]any{}, "must not be empty"},
		{FromAPI, "llmModelPrices", "x", "must be an object"},
		{FromAPI, "llmModelPrices", map[string]any{" ": map[string]any{"inputPerMTok": float64(1), "outputPerMTok": float64(1)}}, "non-blank"},
		{FromAPI, "llmModelPrices", map[string]any{strings.Repeat("m", 201): map[string]any{"inputPerMTok": float64(1), "outputPerMTok": float64(1)}}, "non-blank"},
		{FromAPI, "llmModelPrices", map[string]any{"m": map[string]any{"inputPerMTok": float64(1)}}, "[m] needs inputPerMTok and outputPerMTok"},
		{FromAPI, "llmModelPrices", map[string]any{"m": map[string]any{"inputPerMTok": float64(1), "outputPerMTok": nil}}, "[m] needs inputPerMTok and outputPerMTok"},
		{FromAPI, "llmModelPrices", map[string]any{"m": map[string]any{"inputPerMTok": float64(1), "outputPerMTok": float64(1), "x": float64(1)}}, "unknown key x"},
		{FromAPI, "llmModelPrices", map[string]any{"m": map[string]any{"inputPerMTok": float64(-1), "outputPerMTok": float64(1)}}, "inputPerMTok must be a number >= 0"},
		{FromAPI, "llmModelPrices", map[string]any{"m": map[string]any{"inputPerMTok": float64(1), "outputPerMTok": "1"}}, "outputPerMTok must be a number >= 0"},
		// cleared values delete and need no type
		{FromAPI, "port", "", ""},
		{FromAPI, "OPENAI_API_KEY", "  ", ""},
	}
	for _, c := range cases {
		err := Check(c.o, c.key, c.val)
		if c.error == "" && err != nil {
			t.Errorf("%s %s=%v: refused: %v", c.o, c.key, c.val, err)
		}
		if c.error != "" && (err == nil || !strings.Contains(err.Error(), c.error)) {
			t.Errorf("%s %s=%v: got %v, want %q", c.o, c.key, c.val, err, c.error)
		}
	}
}

func TestFindPathInputForms(t *testing.T) {
	for _, s := range []string{"XAU/USD", "XAU/USD|H1", "EUR/USD|M5", "gpt-5", "openai/gpt-5", "https://api.example.com"} {
		if p := findPath(s); p != "" {
			t.Errorf("value %q: refused as a path", s)
		}
		if p := findPath(map[string]any{s: float64(1)}); p != "" {
			t.Errorf("key %q: refused as a path", s)
		}
	}
	for _, s := range []string{"/etc/passwd", "/etc/passwd|M5", "~/x|H1", "FILE:///etc/passwd", " /usr/bin/env", "\t~/bin/x", "File:x",
		"x/../../etc/passwd", "openai/../../../bin/sh", "openai/..", ".."} {
		if p := findPath(s); p != s {
			t.Errorf("value %q: got %q", s, p)
		}
		if p := findPath(map[string]any{s: float64(1)}); p != s {
			t.Errorf("key %q: got %q", s, p)
		}
	}
}

func TestCheckNamesTheFirstSortedBadEntry(t *testing.T) {
	v := map[string]any{"bots": map[string]any{
		"B/USD|M5": map[string]any{"enabled": "y"},
		"A/USD|M5": map[string]any{"enabled": "x"},
		"C/USD|M5": map[string]any{"enabled": "z"},
	}}
	for range 20 {
		if err := Check(FromAPI, "bot", v); err == nil || !strings.Contains(err.Error(), "[A/USD|M5]") {
			t.Fatalf("got %v, want the A/USD|M5 entry", err)
		}
	}
}

func TestCheckAllListsEveryRefusal(t *testing.T) {
	err := CheckAll(FromAPI, map[string]any{"zzz": 1, "port": "x", "model": "m"})
	if err == nil || !strings.Contains(err.Error(), "zzz") || !strings.Contains(err.Error(), "port") {
		t.Fatal(err)
	}
	if errors.Is(err, ErrInvalid) {
		t.Fatal("CheckAll returns the plain list; Write wraps it")
	}
}

func TestMaskedHidesSecretsAndJobOwners(t *testing.T) {
	out := Masked(map[string]any{"OPENAI_API_KEY": "sk-fake", "PUSHOVER_USER": "u-fake", "port": float64(1), "jobOwner.bot": "go"})
	if out["OPENAI_API_KEY"] != Mask || out["PUSHOVER_USER"] != Mask || out["port"] != float64(1) {
		t.Fatal(out)
	}
	if _, ok := out["jobOwner.bot"]; ok {
		t.Fatal("job owner flag leaked into the console view")
	}
}

func TestBotsWithoutPair(t *testing.T) {
	vals := map[string]any{
		"watchers": "WTICO/USD, XAU/USD|H1",
		"bot": map[string]any{"bots": map[string]any{
			"WTICO/USD | M5": map[string]any{"enabled": true},
			"XAU/USD|H1":     map[string]any{"enabled": true},
			"NAS100/USD|M5":  map[string]any{"enabled": true},
			"SPX500/USD|M5":  map[string]any{"enabled": false},
		}},
	}
	if got := botsWithoutPair(vals); !slices.Equal(got, []string{"NAS100/USD|M5"}) {
		t.Fatal(got)
	}
}

func TestBotsWithoutPairUsesTheEngineFallback(t *testing.T) {
	bots := map[string]any{"bots": map[string]any{
		"XAU/USD|H1":   map[string]any{"enabled": true},
		"WTICO/USD|M5": map[string]any{"enabled": true},
		"BCO/USD|M5":   map[string]any{"enabled": true},
	}}
	cases := []struct {
		vals map[string]any
		want []string
	}{
		// absent or empty watchers: the engine watches instrument|granularity
		{map[string]any{"instrument": "XAU/USD", "granularity": "H1", "bot": bots}, []string{"BCO/USD|M5", "WTICO/USD|M5"}},
		{map[string]any{"watchers": " , ", "instrument": "XAU/USD", "granularity": "H1", "bot": bots}, []string{"BCO/USD|M5", "WTICO/USD|M5"}},
		// no instrument or granularity: the engine defaults to BCO/USD and M5
		{map[string]any{"bot": bots}, []string{"WTICO/USD|M5", "XAU/USD|H1"}},
		// a non-empty watcher list replaces the fallback
		{map[string]any{"watchers": "WTICO/USD", "instrument": "XAU/USD", "granularity": "H1", "bot": bots}, []string{"BCO/USD|M5", "XAU/USD|H1"}},
	}
	for _, c := range cases {
		if got := botsWithoutPair(c.vals); !slices.Equal(got, c.want) {
			t.Errorf("%v: got %v, want %v", c.vals, got, c.want)
		}
	}
}
