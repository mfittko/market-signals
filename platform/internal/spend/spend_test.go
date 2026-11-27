package spend_test

import (
	"context"
	"math"
	"testing"
	"time"

	"github.com/mfittko/market-signals/platform/internal/settings"
	"github.com/mfittko/market-signals/platform/internal/spend"
	"github.com/mfittko/market-signals/platform/internal/testutil"
)

func TestCost(t *testing.T) {
	prices := map[string]spend.Price{
		"cheap": {InputPerMTok: 0.5, OutputPerMTok: 4},
		"dear":  {InputPerMTok: 2, OutputPerMTok: 3},
	}
	for _, c := range []struct {
		name, model, as    string
		prompt, completion int64
		want               float64
	}{
		{"known model", "cheap", "cheap", 1_000_000, 1_000_000, 4.5},
		{"other known model", "dear", "dear", 500_000, 0, 1},
		{"no tokens", "cheap", "cheap", 0, 0, 0},
		// the highest input and the highest output rate, taken separately
		{"unknown model", "new-model", spend.MaxPriced, 1_000_000, 1_000_000, 6},
		{"match is case-sensitive", "Cheap", spend.MaxPriced, 0, 1_000_000, 4},
	} {
		got, as := spend.Cost(prices, c.model, c.prompt, c.completion)
		if math.Abs(got-c.want) > 1e-9 || as != c.as {
			t.Errorf("%s: got %v %q, want %v %q", c.name, got, as, c.want, c.as)
		}
	}
}

func TestConfigDefaultsAndStoredValues(t *testing.T) {
	prices, capUSD := spend.Config(map[string]any{})
	if capUSD != 5 || len(prices) != 2 || prices["gpt-5.4-mini"] != (spend.Price{InputPerMTok: 0.75, OutputPerMTok: 4.5}) ||
		prices["glm-5"] != (spend.Price{InputPerMTok: 1, OutputPerMTok: 3.2}) {
		t.Fatalf("absent keys must resolve to the code defaults: %v %v", prices, capUSD)
	}
	prices, capUSD = spend.Config(map[string]any{
		"llmDailyCapUsd": float64(12.5),
		"llmModelPrices": map[string]any{"m": map[string]any{"inputPerMTok": float64(1), "outputPerMTok": float64(2)}},
	})
	if capUSD != 12.5 || len(prices) != 1 || prices["m"] != (spend.Price{InputPerMTok: 1, OutputPerMTok: 2}) {
		t.Fatalf("stored keys win: %v %v", prices, capUSD)
	}
}

func TestCapReached(t *testing.T) {
	if spend.CapReached(4.99, 5) || !spend.CapReached(5, 5) || !spend.CapReached(6, 5) {
		t.Fatal("the cap is reached at spent >= cap")
	}
}

func TestMigrationChecks(t *testing.T) {
	pool := testutil.Pool(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `INSERT INTO model_spend (call_site, provider, model, priced_as, prompt_tokens, completion_tokens, cost_usd)
		VALUES ('agent', 'p', 'm', 'm', 1, 2, 0.1)`); err != nil {
		t.Fatalf("a valid row must insert: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO model_spend (call_site, provider, model, priced_as, prompt_tokens, completion_tokens, cost_usd)
		VALUES ('agent', 'p', 'm', 'm', -1, 2, 0.1)`); err == nil {
		t.Fatal("a negative token count must be refused")
	}
}

func TestRecordPricesAndStoresOneRow(t *testing.T) {
	pool := testutil.Pool(t)
	ctx := context.Background()
	if _, _, err := settings.Write(ctx, pool, settings.FromAPI, map[string]any{
		"llmModelPrices": map[string]any{"m": map[string]any{"inputPerMTok": float64(1), "outputPerMTok": float64(10)}},
	}, nil); err != nil {
		t.Fatal(err)
	}
	// run id 99 names no run, so it is stored as NULL
	for _, c := range []spend.Call{
		{CallSite: "coach", Provider: "http://p/v1/chat/completions", Model: "m", PromptTokens: 1_000_000, CompletionTokens: 100_000},
		{CallSite: "agent", Provider: "p", Model: "other", CompletionTokens: 1_000_000, Estimated: true, RunID: 99},
	} {
		if err := spend.Record(ctx, pool, c); err != nil {
			t.Fatal(err)
		}
	}
	rows, err := pool.Query(ctx, `SELECT call_site, model, priced_as, cost_usd, estimated, run_id IS NULL FROM model_spend ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	type row struct {
		site, model, as string
		cost            float64
		est, noRun      bool
	}
	var got []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.site, &r.model, &r.as, &r.cost, &r.est, &r.noRun); err != nil {
			t.Fatal(err)
		}
		got = append(got, r)
	}
	want := []row{{"coach", "m", "m", 2, false, true}, {"agent", "other", spend.MaxPriced, 10, true, true}}
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestTodaySumsOnlyTheCurrentUTCDay(t *testing.T) {
	pool := testutil.Pool(t)
	ctx := context.Background()
	for _, r := range []struct {
		at   string
		cost float64
	}{{"2026-11-26T23:59:59Z", 100}, {"2026-11-27T00:00:00Z", 1.25}, {"2026-11-27T23:59:59Z", 2}, {"2026-11-28T00:00:00Z", 50}} {
		at, _ := time.Parse(time.RFC3339, r.at)
		if _, err := pool.Exec(ctx, `INSERT INTO model_spend (at, call_site, provider, model, priced_as, prompt_tokens, completion_tokens, cost_usd)
			VALUES ($1, 'agent', 'p', 'm', 'm', 0, 0, $2)`, at, r.cost); err != nil {
			t.Fatal(err)
		}
	}
	// a New York evening is already the next UTC day; the window follows UTC
	ny, _ := time.LoadLocation("America/New_York")
	now := time.Date(2026, 11, 27, 20, 0, 0, 0, ny)
	spent, capUSD, err := spend.Today(ctx, pool, now)
	if err != nil || spent != 50 || capUSD != 5 {
		t.Fatalf("at %v: got %v of %v, %v", now, spent, capUSD, err)
	}
	spent, _, err = spend.Today(ctx, pool, time.Date(2026, 11, 27, 18, 0, 0, 0, time.UTC))
	if err != nil || spent != 3.25 {
		t.Fatalf("got %v %v, want 3.25", spent, err)
	}
}
