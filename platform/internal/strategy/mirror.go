package strategy

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mfittko/market-signals/platform/internal/legacy"
)

// Clash is an engine version whose (name, version) is stored with a different prompt,
// or whose engine id is stored on another version. The stored row is kept.
type Clash struct {
	Name    string `json:"name"`
	Version int    `json:"version"`
}

type MirrorReport struct {
	Source   int     `json:"source"`
	Inserted int     `json:"inserted"`
	Skipped  int     `json:"skipped"` // already stored with the same prompt
	Clashes  []Clash `json:"clashes"`
}

// Mirror copies the engine strategy versions that Postgres does not hold yet, with the engine's
// flags and row id. It never changes a stored version except to fill a missing engine id, so a
// rerun on unchanged input inserts nothing. Specs are mirrored as the engine stores them.
func Mirror(ctx context.Context, pool *pgxpool.Pool, sqlitePath string) (MirrorReport, error) {
	rows, err := legacy.ReadStrategies(ctx, sqlitePath)
	if err != nil {
		return MirrorReport{}, err
	}
	rep := MirrorReport{Source: len(rows), Clashes: []Clash{}}
	err = pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		for _, s := range rows {
			tag, err := tx.Exec(ctx, legacy.StrategyInsert, s.Args()...)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 1 {
				rep.Inserted++
				continue
			}
			var same bool
			err = tx.QueryRow(ctx, `SELECT prompt = $3 FROM strategies WHERE name=$1 AND version=$2`, s.Name, s.Version, s.Prompt).Scan(&same)
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			if !same {
				rep.Clashes = append(rep.Clashes, Clash{s.Name, s.Version})
				continue
			}
			rep.Skipped++
			// a version stored by the one-shot import before engine ids existed gets its id now
			if _, err := tx.Exec(ctx, `UPDATE strategies SET engine_id=$3 WHERE name=$1 AND version=$2 AND engine_id IS NULL
				AND NOT EXISTS (SELECT 1 FROM strategies WHERE engine_id=$3)`, s.Name, s.Version, s.ID); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return MirrorReport{}, err
	}
	return rep, nil
}

// PromptHash is the strategyVersion a bot_journal row carries: the first 8 hex digits of the
// prompt's SHA-256, as strategyVersion in scripts/bot.mjs computes it.
func PromptHash(prompt string) string {
	sum := sha256.Sum256([]byte(prompt))
	return hex.EncodeToString(sum[:])[:8]
}

// VersionForHash maps a journal row's strategy name and prompt hash to the stored version.
// When several versions share a prompt, the highest wins.
func VersionForHash(ctx context.Context, q Querier, name, hash string) (int, bool, error) {
	var v int
	err := q.QueryRow(ctx, `SELECT version FROM strategies
		WHERE name=$1 AND left(encode(sha256(convert_to(prompt,'UTF8')),'hex'),8)=$2
		ORDER BY version DESC LIMIT 1`, name, hash).Scan(&v)
	return found(v, err)
}
