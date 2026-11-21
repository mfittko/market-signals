package strategy

import (
	"context"
	"errors"
	"maps"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
)

// BotFor is the per-combo bot config, the shape resolveBotFor in scripts/bot.mjs returns.
// A combo without a bot has Configured false and every other field empty.
type BotFor struct {
	Configured            bool     `json:"configured"`
	Enabled               bool     `json:"enabled"`
	StrategyID            *int64   `json:"strategyId"`
	StrategyName          *string  `json:"strategyName"`
	RiskPct               *float64 `json:"riskPct"`
	AllocationPct         *float64 `json:"allocationPct"`
	KillSwitchDrawdownPct *float64 `json:"killSwitchDrawdownPct"`
}

// Active is the active version of one strategy name.
type Active struct {
	Name    string
	Version int
	Prompt  string
}

// Lookup reads the strategy store. Each found flag is false when no row matches.
type Lookup interface {
	// ActiveName returns the name of some active strategy (the legacy single-bot config).
	ActiveName(ctx context.Context) (string, bool, error)
	// NameByEngineID returns the name of the row with an engine id, archived rows included.
	NameByEngineID(ctx context.Context, id int64) (string, bool, error)
	ActiveByName(ctx context.Context, name string) (Active, bool, error)
}

// normCombo is the engine's one combo-key normalization rule.
func normCombo(k string) string {
	parts := strings.Split(k, "|")
	for i, p := range parts {
		parts[i] = strings.TrimSpace(p)
	}
	return strings.Join(parts, "|")
}

// object reads v as the engine reads `typeof v === 'object'`: an array is an object without fields.
func object(v any) (map[string]any, bool) {
	switch x := v.(type) {
	case map[string]any:
		return x, true
	case []any:
		return map[string]any{}, true
	}
	return nil, false
}

func positive(v any) *float64 {
	if n, ok := v.(float64); ok && n > 0 {
		return &n
	}
	return nil
}

// ResolveBotFor ports resolveBotFor in scripts/bot.mjs. settings is the decoded settings.json.
func ResolveBotFor(ctx context.Context, settings map[string]any, instrument, granularity string, lk Lookup) (BotFor, error) {
	bot, _ := settings["bot"].(map[string]any)
	key := instrument + "|" + granularity
	var entry map[string]any
	if bots, ok := object(bot["bots"]); ok {
		// once a bots map exists, the legacy flat branch is dead
		var found bool
		if entry, found = object(bots[key]); !found && bots[key] == nil {
			// shortcut: Go maps have no key order, so among keys that normalize alike the
			// first sorted key wins where the engine takes the first written; the write path normalizes keys.
			for _, k := range slices.Sorted(maps.Keys(bots)) {
				if normCombo(k) == key {
					if e, ok := object(bots[k]); ok {
						entry = e
						break
					}
				}
			}
		}
	} else if bot["enabled"] == true {
		// legacy flat config: the watchers CSV (or every combo when unset) binds the globally active strategy
		csv, _ := bot["watchers"].(string)
		csv = strings.TrimSpace(csv)
		match := csv == ""
		for _, c := range strings.Split(csv, ",") {
			if c = normCombo(c); csv != "" && c != "" && c != "|" && c == key {
				match = true
			}
		}
		if match {
			name, ok, err := lk.ActiveName(ctx)
			if err != nil {
				return BotFor{}, err
			}
			entry = map[string]any{"enabled": true, "strategyName": nil}
			if ok {
				entry["strategyName"] = name
			}
		}
	}
	if entry == nil {
		return BotFor{}, nil
	}

	var legacyID *int64
	if n, ok := entry["strategyId"].(float64); ok && isInt(n) {
		id := int64(n)
		legacyID = &id
	}
	b := BotFor{
		Configured:            true,
		Enabled:               entry["enabled"] == true,
		StrategyID:            legacyID,
		RiskPct:               positive(entry["riskPct"]),
		AllocationPct:         positive(entry["allocationPct"]),
		KillSwitchDrawdownPct: positive(entry["killSwitchDrawdownPct"]),
	}
	raw, named := entry["strategyName"]
	if s, ok := raw.(string); ok && s != "" {
		b.StrategyName = &s
	} else if !named && legacyID != nil {
		// a legacy row id resolves to its name, archived rows included, then follows that name's active version
		name, ok, err := lk.NameByEngineID(ctx, *legacyID)
		if err != nil {
			return BotFor{}, err
		}
		if ok {
			b.StrategyName = &name
		}
	}
	if named && raw == nil {
		// an explicit null name is a deliberate detach: drop the legacy id too
		b.StrategyID = nil
	}
	return b, nil
}

// ResolvedStrategy ports resolvedStrategy in scripts/bot.mjs: the active version of the bot's strategy name.
func ResolvedStrategy(ctx context.Context, lk Lookup, b BotFor) (Active, bool, error) {
	if b.StrategyName == nil || *b.StrategyName == "" {
		return Active{}, false, nil
	}
	return lk.ActiveByName(ctx, *b.StrategyName)
}

// Querier is the read side of a pool or transaction.
type Querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// Store is the Postgres Lookup.
type Store struct{ Q Querier }

func found[T any](v T, err error) (T, bool, error) {
	if errors.Is(err, pgx.ErrNoRows) {
		return v, false, nil
	}
	return v, err == nil, err
}

// ActiveName picks the first active row in engine order, as the engine's unordered SQLite read does.
func (s Store) ActiveName(ctx context.Context) (string, bool, error) {
	var n string
	err := s.Q.QueryRow(ctx, `SELECT name FROM strategies WHERE active ORDER BY engine_id NULLS LAST, name, version LIMIT 1`).Scan(&n)
	return found(n, err)
}

func (s Store) NameByEngineID(ctx context.Context, id int64) (string, bool, error) {
	var n string
	err := s.Q.QueryRow(ctx, `SELECT name FROM strategies WHERE engine_id=$1`, id).Scan(&n)
	return found(n, err)
}

// ActiveByName takes the highest active version: the mirror never clears the active flag of an older
// mirrored version, so after the engine activates a newer one both rows can be active here.
func (s Store) ActiveByName(ctx context.Context, name string) (Active, bool, error) {
	var a Active
	err := s.Q.QueryRow(ctx, `SELECT name, version, prompt FROM strategies WHERE name=$1 AND active ORDER BY version DESC LIMIT 1`, name).Scan(&a.Name, &a.Version, &a.Prompt)
	return found(a, err)
}
