package settings

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"slices"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrInvalid wraps every schema refusal, so a route can answer 400 instead of 500.
var ErrInvalid = errors.New("invalid settings")

// PairError refuses a write that leaves an enabled bot without its watcher pair.
type PairError struct{ Pairs []string }

func (e PairError) Error() string {
	return "an enabled bot needs its pair in the watcher list: " + strings.Join(e.Pairs, ", ")
}

// lockKey serializes settings writers, so the revision and the bot-pair rule see one state.
const lockKey = 727347

// Snapshot is the stored settings at one revision. Revision 0 means nothing is stored yet.
type Snapshot struct {
	Revision int64
	Values   map[string]any
}

type querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// Load reads every stored key and the current revision from one snapshot, so a write that
// commits during the read cannot pair the old revision with the new values.
func Load(ctx context.Context, pool *pgxpool.Pool) (Snapshot, error) {
	var snap Snapshot
	err := pgx.BeginTxFunc(ctx, pool, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) error {
		var err error
		snap, err = load(ctx, tx)
		return err
	})
	return snap, err
}

func load(ctx context.Context, q querier) (Snapshot, error) {
	snap := Snapshot{Values: map[string]any{}}
	if err := q.QueryRow(ctx, `SELECT COALESCE(max(revision), 0) FROM settings_revisions`).Scan(&snap.Revision); err != nil {
		return snap, err
	}
	rows, err := q.Query(ctx, `SELECT key, value FROM settings`)
	if err != nil {
		return snap, err
	}
	defer rows.Close()
	for rows.Next() {
		var k string
		var v any
		if err := rows.Scan(&k, &v); err != nil {
			return snap, err
		}
		snap.Values[k] = v
	}
	return snap, rows.Err()
}

// Masked is the console view: every secret is replaced by Mask and job owner flags are left out.
func Masked(vals map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range vals {
		switch {
		case schema[k].goOnly:
		case IsSecret(k):
			out[k] = Mask
		default:
			out[k] = v
		}
	}
	return out
}

// Write validates patch for the origin and stores it as one revision. Each value replaces
// its key; a cleared value deletes it and a secret sent as Mask keeps the stored one. Keys
// whose value does not change are skipped, and a patch that changes nothing adds no revision.
// It returns the state after the write and the changed keys.
func Write(ctx context.Context, pool *pgxpool.Pool, o Origin, patch map[string]any) (Snapshot, []string, error) {
	if err := CheckAll(o, patch); err != nil {
		return Snapshot{}, nil, fmt.Errorf("%w: %s", ErrInvalid, err.Error())
	}
	var out Snapshot
	var changed []string
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, lockKey); err != nil {
			return err
		}
		cur, err := load(ctx, tx)
		if err != nil {
			return err
		}
		next := maps.Clone(cur.Values)
		changed = []string{} // an empty list, never JSON null
		for k, v := range patch {
			old, had := cur.Values[k]
			switch {
			case IsSecret(k) && v == Mask:
			case Cleared(k, v):
				if had {
					delete(next, k)
					changed = append(changed, k)
				}
			case !had || !sameJSON(old, v):
				next[k] = v
				changed = append(changed, k)
			}
		}
		out = Snapshot{Revision: cur.Revision, Values: next}
		if len(changed) == 0 {
			return nil
		}
		sort.Strings(changed)
		// The import mirrors the live file as it is; the rule binds the writers that the Go store owns.
		// instrument and granularity count because they define the watched pair when watchers is empty.
		if o != FromImport && slices.ContainsFunc(changed, func(k string) bool {
			return k == "watchers" || k == "bot" || k == "instrument" || k == "granularity"
		}) {
			if missing := botsWithoutPair(next); len(missing) > 0 {
				return PairError{missing}
			}
		}
		if err := tx.QueryRow(ctx, `INSERT INTO settings_revisions (source, keys) VALUES ($1, $2) RETURNING revision`,
			string(o), changed).Scan(&out.Revision); err != nil {
			return err
		}
		for _, k := range changed {
			if v, ok := next[k]; ok {
				// pgx sends a string or []byte argument as raw JSON text, so encode every value first.
				var raw []byte
				if raw, err = json.Marshal(v); err == nil {
					_, err = tx.Exec(ctx, `INSERT INTO settings (key, value, revision) VALUES ($1, $2, $3)
						ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, revision = EXCLUDED.revision`, k, raw, out.Revision)
				}
			} else {
				_, err = tx.Exec(ctx, `DELETE FROM settings WHERE key = $1`, k)
			}
			if err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return Snapshot{}, nil, err
	}
	return out, changed, nil
}

// sameJSON compares two decoded JSON values. Marshal sorts object keys, so equal values give equal bytes.
func sameJSON(a, b any) bool {
	x, err1 := json.Marshal(a)
	y, err2 := json.Marshal(b)
	return err1 == nil && err2 == nil && string(x) == string(y)
}

// ImportReport lists what one import run did. Skipped lists each key the schema refused as
// "key: reason". The reason can quote nested key names from the file, never a value.
type ImportReport struct {
	Revision int64    `json:"revision"`
	Changed  []string `json:"changed"`
	Skipped  []string `json:"skipped"`
	Notes    []string `json:"notes"`
}

// Import mirrors a legacy settings.json into the store, one way. A schema key absent from
// the file is deleted; a refused key keeps its stored value and is reported. Job owner
// flags are never touched. Rerunning it on an unchanged file adds no revision.
func Import(ctx context.Context, pool *pgxpool.Pool, path string) (ImportReport, error) {
	rep := ImportReport{Changed: []string{}, Skipped: []string{}, Notes: []string{}}
	b, err := os.ReadFile(path)
	if err != nil {
		return rep, err
	}
	var file map[string]any
	if err := json.Unmarshal(b, &file); err != nil || file == nil {
		return rep, fmt.Errorf("%s is not a JSON object", path)
	}
	if fi, err := os.Stat(path); err == nil && fi.Mode().Perm()&0o077 != 0 {
		rep.Notes = append(rep.Notes, fmt.Sprintf("%s holds secrets and is readable by other users (mode %o); chmod 600 it", path, fi.Mode().Perm()))
	}
	patch := map[string]any{}
	for k, sp := range schema {
		if !sp.goOnly {
			patch[k] = nil
		}
	}
	for k, v := range file {
		if err := Check(FromImport, k, v); err != nil {
			rep.Skipped = append(rep.Skipped, err.Error())
			delete(patch, k)
			continue
		}
		patch[k] = v
	}
	sort.Strings(rep.Skipped)
	snap, changed, err := Write(ctx, pool, FromImport, patch)
	rep.Revision, rep.Changed = snap.Revision, changed
	return rep, err
}
