package settings

import (
	"context"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// OpenAIBaseURL is the fixed base URL of the official openai flavor.
const OpenAIBaseURL = "https://api.openai.com/v1"

// OpenAIProvider resolves the OpenAI-shaped model endpoint from the settings values, with the engine's rule
// (resolveProvider, openaiEndpoint and effectiveModel in scripts/supertrend.mjs). A non-blank OPENAI_BASE_URL
// means the openai-compatible flavor at that base URL; a blank one means official OpenAI, unless the provider is
// set to openai-compatible, which is a misconfiguration. The model is models[flavor], then the flat model when
// the flavor is the active provider, then gpt-5.4-mini for official OpenAI. ok is false without a key.
func OpenAIProvider(vals map[string]any) (baseURL, apiKey, model string, ok bool) {
	str := func(k string) string { s, _ := vals[k].(string); return strings.TrimSpace(s) }
	apiKey = str("OPENAI_API_KEY")
	if apiKey == "" {
		return "", "", "", false
	}
	flavor, provider := "openai", str("provider")
	switch baseURL = str("OPENAI_BASE_URL"); {
	case baseURL != "":
		flavor = "openai-compatible"
	case provider == "openai-compatible":
		return "", "", "", false
	default:
		baseURL = OpenAIBaseURL
	}
	active := flavor
	switch {
	case slices.Contains(providers, provider) && provider != "openai":
		active = provider
	case !slices.Contains(providers, provider) && str("ANTHROPIC_API_KEY") != "":
		active = "anthropic"
	}
	ms, _ := vals["models"].(map[string]any)
	model, _ = ms[flavor].(string)
	if model == "" && active == flavor {
		model, _ = vals["model"].(string)
	}
	if model == "" && flavor == "openai" {
		model = "gpt-5.4-mini"
	}
	return baseURL, apiKey, model, true
}

// LLM reads the stored settings and resolves the OpenAI-shaped provider from them. It reads on every call.
func LLM(ctx context.Context, pool *pgxpool.Pool) (baseURL, apiKey, model string, ok bool, err error) {
	snap, err := Load(ctx, pool)
	if err != nil {
		return "", "", "", false, err
	}
	baseURL, apiKey, model, ok = OpenAIProvider(snap.Values)
	return baseURL, apiKey, model, ok, nil
}
