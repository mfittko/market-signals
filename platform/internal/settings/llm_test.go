package settings_test

import (
	"testing"

	"github.com/mfittko/market-signals/platform/internal/settings"
)

// The golden table follows the jq rule that scripts/dev.sh used before the gateway read the store.
func TestOpenAIProviderMatchesTheEngineRule(t *testing.T) {
	const key, compat = "sk-test-SECRET", "https://llm.example.test/v1"
	for _, c := range []struct {
		name        string
		vals        map[string]any
		base, model string
		ok          bool
	}{
		{"official openai", map[string]any{"OPENAI_API_KEY": key, "provider": "openai"}, settings.OpenAIBaseURL, "gpt-5.4-mini", true},
		{"compatible with a base URL", map[string]any{"OPENAI_API_KEY": key, "provider": "openai-compatible", "OPENAI_BASE_URL": "  " + compat + " ", "model": "glm-5"}, compat, "glm-5", true},
		{"compatible without a base URL", map[string]any{"OPENAI_API_KEY": key, "provider": "openai-compatible", "model": "glm-5"}, "", "", false},
		{"openai with a base URL is compatible", map[string]any{"OPENAI_API_KEY": key, "provider": "openai", "OPENAI_BASE_URL": compat, "model": "glm-5"}, compat, "glm-5", true},
		{"blank key", map[string]any{"OPENAI_API_KEY": "  ", "provider": "openai"}, "", "", false},
		{"no key", map[string]any{"provider": "openai", "model": "gpt-x"}, "", "", false},
		{"models map wins", map[string]any{"OPENAI_API_KEY": key, "provider": "openai", "model": "flat", "models": map[string]any{"openai": "gpt-bound", "openai-compatible": "other"}}, settings.OpenAIBaseURL, "gpt-bound", true},
		{"flat model, active flavor", map[string]any{"OPENAI_API_KEY": key, "provider": "openai", "model": "gpt-flat"}, settings.OpenAIBaseURL, "gpt-flat", true},
		{"flat model, inactive compatible flavor", map[string]any{"OPENAI_API_KEY": key, "provider": "anthropic", "OPENAI_BASE_URL": compat, "model": "claude-x"}, compat, "", true},
		{"provider pi", map[string]any{"OPENAI_API_KEY": key, "provider": "pi", "model": "pi-model"}, settings.OpenAIBaseURL, "gpt-5.4-mini", true},
		{"provider claude-code", map[string]any{"OPENAI_API_KEY": key, "provider": "claude-code", "model": "sonnet"}, settings.OpenAIBaseURL, "gpt-5.4-mini", true},
		{"provider anthropic", map[string]any{"OPENAI_API_KEY": key, "provider": "anthropic", "model": "claude-x", "models": map[string]any{"openai": "gpt-bound"}}, settings.OpenAIBaseURL, "gpt-bound", true},
		{"legacy anthropic key makes anthropic active", map[string]any{"OPENAI_API_KEY": key, "ANTHROPIC_API_KEY": "sk-test-OTHER", "model": "claude-x"}, settings.OpenAIBaseURL, "gpt-5.4-mini", true},
		{"legacy, no provider", map[string]any{"OPENAI_API_KEY": key, "model": "gpt-flat"}, settings.OpenAIBaseURL, "gpt-flat", true},
		{"compatible default is empty", map[string]any{"OPENAI_API_KEY": key, "OPENAI_BASE_URL": compat}, compat, "", true},
	} {
		t.Run(c.name, func(t *testing.T) {
			base, k, model, ok := settings.OpenAIProvider(c.vals)
			if ok != c.ok || base != c.base || model != c.model || (ok && k != key) || (!ok && k != "") {
				t.Fatalf("got (%q, key set %v, %q, %v), want (%q, %q, %v)", base, k != "", model, ok, c.base, c.model, c.ok)
			}
		})
	}
}
