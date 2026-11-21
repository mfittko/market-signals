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
		// job owner flags: operator route only
		{FromAPI, "jobOwner.bot", "go", "operator route"},
		{FromImport, "jobOwner.bot", "go", "operator route"},
		{FromOperator, "jobOwner.bot", "go", ""},
		{FromOperator, "jobOwner.bot", "rust", "must be one of"},
		{FromOperator, "port", float64(1), "only job owner flags"},
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
