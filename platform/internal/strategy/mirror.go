package strategy

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mfittko/market-signals/platform/internal/legacy"
)

// Clash is an engine version whose (name, version) is stored with a different prompt and no engine
// id, or whose engine id is stored on another version, or a later engine version of a name that
// already clashed in this run. The stored rows are kept and the clash is left unimported.
// Recreated uses the same shape for a version the engine deleted and saved again under a new id.
type Clash struct {
	Name    string `json:"name"`
	Version int    `json:"version"`
}

type MirrorReport struct {
	Source    int     `json:"source"`
	Inserted  int     `json:"inserted"`
	Skipped   int     `json:"skipped"` // already stored with the same prompt
	Clashes   []Clash `json:"clashes"`
	Recreated []Clash `json:"recreated"` // stored under another engine id; the stored row is kept
}

// Mirror copies the engine strategy versions that Postgres does not hold yet, with the engine's
// flags and row id. It changes a stored version only to fill a missing engine id, to move the
// engine id of a recreated version with the same prompt, or to clear `active` when it inserts an
// active version of the same name, so a rerun on unchanged input inserts nothing. After a clash it
// skips the rest of that name, so one name never mixes console and engine histories. A recreated
// version does not stop the name. Specs are mirrored as the engine stores them.
func Mirror(ctx context.Context, pool *pgxpool.Pool, sqlitePath string) (MirrorReport, error) {
	rows, err := legacy.ReadStrategies(ctx, sqlitePath)
	if err != nil {
		return MirrorReport{}, err
	}
	rep := MirrorReport{Source: len(rows), Clashes: []Clash{}, Recreated: []Clash{}}
	err = pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		clashed := map[string]bool{}
		for _, s := range rows {
			if clashed[s.Name] {
				rep.Clashes = append(rep.Clashes, Clash{s.Name, s.Version})
				continue
			}
			// the same locks in the same order as the console save, so a concurrent save waits
			if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, "strategy-name:"+strings.ToLower(s.Name)); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, "strategy:"+s.Name); err != nil {
				return err
			}
			tag, err := tx.Exec(ctx, legacy.StrategyInsert, s.Args()...)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 1 {
				rep.Inserted++
				// one active version per name, as the engine and the console keep it
				if s.Active {
					if _, err := tx.Exec(ctx, `UPDATE strategies SET active=false WHERE name=$1 AND version<>$2 AND active`, s.Name, s.Version); err != nil {
						return err
					}
				}
				continue
			}
			var same bool
			var engineID *int64
			err = tx.QueryRow(ctx, `SELECT prompt = $3, engine_id FROM strategies WHERE name=$1 AND version=$2`, s.Name, s.Version, s.Prompt).Scan(&same, &engineID)
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			if engineID != nil && *engineID != s.ID {
				// the engine deleted this version and saved it again under a new id
				rep.Recreated = append(rep.Recreated, Clash{s.Name, s.Version})
				if same { // the deleted id carried no journal row, so the new id takes its place
					if _, err := tx.Exec(ctx, `UPDATE strategies SET engine_id=$3 WHERE name=$1 AND version=$2
						AND NOT EXISTS (SELECT 1 FROM strategies WHERE engine_id=$3)`, s.Name, s.Version, s.ID); err != nil {
						return err
					}
				}
				continue
			}
			if !same {
				clashed[s.Name] = true
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
