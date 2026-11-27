// Package spend is the model spend ledger. It prices each model call from the settings price table and is the
// only writer of the model_spend table. The daily cap counts spend in the current UTC calendar day.
package spend

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mfittko/market-signals/platform/internal/settings"
)

// Price is one model's USD rate per 1M tokens.
type Price struct{ InputPerMTok, OutputPerMTok float64 }

// DefaultPrices apply while llmModelPrices is absent. The rates are assumed, not confirmed by the owner.
var DefaultPrices = map[string]Price{
	"gpt-5.4-mini": {InputPerMTok: 0.75, OutputPerMTok: 4.50},
	"glm-5":        {InputPerMTok: 1.00, OutputPerMTok: 3.20},
}

// DefaultCapUSD applies while llmDailyCapUsd is absent.
const DefaultCapUSD = 5.0

// MaxPriced is the priced_as value of a model without a price entry.
const MaxPriced = "*max*"

// ClaudeCode is the provider, and the priced_as value, of calls through the local Claude Code CLI.
const ClaudeCode = "claude-code"

// Cost prices one call. The lookup is an exact, case-sensitive match on the model. An unknown model is priced at
// the highest input rate and the highest output rate in the table, taken separately, so it never passes as free.
func Cost(prices map[string]Price, model string, prompt, completion int64) (usd float64, pricedAs string) {
	p, ok := prices[model]
	pricedAs = model
	if !ok {
		pricedAs = MaxPriced
		for _, q := range prices {
			p.InputPerMTok, p.OutputPerMTok = max(p.InputPerMTok, q.InputPerMTok), max(p.OutputPerMTok, q.OutputPerMTok)
		}
	}
	return float64(prompt)*p.InputPerMTok/1e6 + float64(completion)*p.OutputPerMTok/1e6, pricedAs
}

// Config resolves the price table and the daily cap from the settings values. An absent key uses the code
// default; settings.Check has already refused an invalid stored value.
func Config(vals map[string]any) (map[string]Price, float64) {
	capUSD := DefaultCapUSD
	if f, ok := vals["llmDailyCapUsd"].(float64); ok {
		capUSD = f
	}
	m, _ := vals["llmModelPrices"].(map[string]any)
	if len(m) == 0 {
		return DefaultPrices, capUSD
	}
	prices := map[string]Price{}
	for name, v := range m {
		e, _ := v.(map[string]any)
		in, _ := e["inputPerMTok"].(float64)
		out, _ := e["outputPerMTok"].(float64)
		prices[name] = Price{InputPerMTok: in, OutputPerMTok: out}
	}
	return prices, capUSD
}

// CapReached reports whether today's spend reached the cap.
func CapReached(spentUSD, capUSD float64) bool { return spentUSD >= capUSD }

// Call is one model call to record. RunID 0, or an id that names no run, is stored as NULL.
type Call struct {
	CallSite, Provider, Model      string
	PromptTokens, CompletionTokens int64
	Estimated                      bool
	RunID                          int64
}

// Record prices the call from the stored price table and inserts one row.
func Record(ctx context.Context, pool *pgxpool.Pool, c Call) error {
	snap, err := settings.Load(ctx, pool)
	if err != nil {
		return err
	}
	prices, _ := Config(snap.Values)
	// claude-code runs on the operator's own subscription, so its rows cost 0 and the cap sum ignores them
	cost, as := 0.0, ClaudeCode
	if c.Provider != ClaudeCode {
		cost, as = Cost(prices, c.Model, c.PromptTokens, c.CompletionTokens)
	}
	_, err = pool.Exec(ctx, `INSERT INTO model_spend (call_site, provider, model, priced_as, prompt_tokens, completion_tokens, estimated, cost_usd, run_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, (SELECT id FROM runs WHERE id = $9))`,
		c.CallSite, c.Provider, c.Model, as, c.PromptTokens, c.CompletionTokens, c.Estimated, cost, c.RunID)
	return err
}

// Today returns the spend of now's UTC calendar day and the effective daily cap.
func Today(ctx context.Context, pool *pgxpool.Pool, now time.Time) (spentUSD, capUSD float64, err error) {
	snap, err := settings.Load(ctx, pool)
	if err != nil {
		return 0, 0, err
	}
	_, capUSD = Config(snap.Values)
	day := now.UTC().Truncate(24 * time.Hour)
	err = pool.QueryRow(ctx, `SELECT COALESCE(sum(cost_usd), 0) FROM model_spend WHERE at >= $1 AND at < $2`, day, day.Add(24*time.Hour)).Scan(&spentUSD)
	return spentUSD, capUSD, err
}
