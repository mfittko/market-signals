package strategy

import (
	"context"
	"database/sql"
	"path/filepath"
	"reflect"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/mfittko/market-signals/platform/internal/legacy"
	"github.com/mfittko/market-signals/platform/internal/testutil"
)

func TestPromptHashIsTheEngineStrategyVersion(t *testing.T) {
	// sha256("abc") starts with ba7816bf; the engine keeps the first 8 hex digits
	if got := PromptHash("abc"); got != "ba7816bf" {
		t.Fatalf("PromptHash: %s", got)
	}
}

// engineDB writes a synthetic engine strategies table; rows are name, version, prompt, active.
func engineDB(t *testing.T, path string, rows ...[4]any) {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS strategies (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, version INTEGER NOT NULL,
		prompt TEXT NOT NULL, spec TEXT, instruments TEXT, instrument TEXT, granularity TEXT, dedicated INTEGER NOT NULL DEFAULT 0,
		created_by TEXT NOT NULL DEFAULT 'manual', created_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, UNIQUE (name, version))`); err != nil {
		t.Fatal(err)
	}
	for _, r := range rows {
		if _, err := db.Exec(`INSERT INTO strategies (name, version, prompt, active, created_at, spec) VALUES (?,?,?,?,'2026-01-05T00:00:00.000Z','{"schema_version":1}')`, r[0], r[1], r[2], r[3]); err != nil {
			t.Fatal(err)
		}
	}
}

func TestMirrorReadsEngineRowsWithIdsAndFlags(t *testing.T) {
	path := filepath.Join(t.TempDir(), "engine.db")
	engineDB(t, path, [4]any{"alpha", 1, "alpha one", 0}, [4]any{"alpha", 2, "alpha two", 1})
	rows, err := legacy.ReadStrategies(context.Background(), path)
	if err != nil || len(rows) != 2 {
		t.Fatalf("%v %v", rows, err)
	}
	if r := rows[1]; r.ID != 2 || r.Name != "alpha" || r.Version != 2 || !r.Active || r.Spec != `{"schema_version":1}` || r.Instrument != nil || r.CreatedAt.IsZero() {
		t.Fatalf("row: %+v", r)
	}
}

func TestMirrorImportsOnlyNewVersionsAndMapsJournalAttribution(t *testing.T) {
	pool := testutil.Pool(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `TRUNCATE strategies`); err != nil {
		t.Fatal(err)
	}
	// beta v1 came in through the one-shot import without an engine id; gamma v1 was written in the console
	for _, r := range [][2]string{{"beta", "beta rules"}, {"gamma", "console rules"}} {
		if _, err := pool.Exec(ctx, `INSERT INTO strategies (name,version,prompt,created_by,created_at,active,archived,dedicated) VALUES ($1,1,$2,'test',now(),true,false,false)`, r[0], r[1]); err != nil {
			t.Fatal(err)
		}
	}
	path := filepath.Join(t.TempDir(), "engine.db")
	engineDB(t, path, [4]any{"alpha", 1, "alpha one", 0}, [4]any{"alpha", 2, "alpha two", 1}, [4]any{"beta", 1, "beta rules", 1}, [4]any{"gamma", 1, "engine rules", 1})

	want := MirrorReport{Source: 4, Inserted: 2, Skipped: 1, Clashes: []Clash{{"gamma", 1}}}
	for run := 1; run <= 2; run++ {
		rep, err := Mirror(ctx, pool, path)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(rep, want) {
			t.Fatalf("run %d: %+v, want %+v", run, rep, want)
		}
		want.Inserted, want.Skipped = 0, 3 // a rerun on unchanged input inserts nothing
	}
	var prompt string
	if err := pool.QueryRow(ctx, `SELECT prompt FROM strategies WHERE name='gamma' AND version=1`).Scan(&prompt); err != nil || prompt != "console rules" {
		t.Fatalf("a clash overwrote the stored row: %q %v", prompt, err)
	}
	var active bool
	var spec string
	if err := pool.QueryRow(ctx, `SELECT active, spec::text FROM strategies WHERE name='alpha' AND version=2`).Scan(&active, &spec); err != nil || !active || spec != `{"schema_version": 1}` {
		t.Fatalf("engine flags and spec: %v %s %v", active, spec, err)
	}

	// a new engine version is the only row the next run inserts
	engineDB(t, path, [4]any{"alpha", 3, "alpha three", 1})
	rep, err := Mirror(ctx, pool, path)
	if err != nil || rep.Inserted != 1 || rep.Skipped != 3 || len(rep.Clashes) != 1 {
		t.Fatalf("new version: %+v %v", rep, err)
	}

	// a journal row carries the engine id, name, version and prompt hash; each maps to the same name and version
	st := Store{pool}
	for id, j := range map[int64]struct {
		name, prompt string
		version      int
	}{1: {"alpha", "alpha one", 1}, 2: {"alpha", "alpha two", 2}, 3: {"beta", "beta rules", 1}, 5: {"alpha", "alpha three", 3}} {
		name, ok, err := st.NameByEngineID(ctx, id)
		if err != nil || !ok || name != j.name {
			t.Fatalf("engine id %d: %q %v %v", id, name, ok, err)
		}
		v, ok, err := VersionForHash(ctx, pool, j.name, PromptHash(j.prompt))
		if err != nil || !ok || v != j.version {
			t.Fatalf("hash of %s v%d: %d %v %v", j.name, j.version, v, ok, err)
		}
	}
	if _, ok, err := st.NameByEngineID(ctx, 4); ok || err != nil {
		t.Fatalf("a clashing engine version got an engine id: %v %v", ok, err)
	}
	// the mirror keeps the older version active, so the active version is the highest one
	if a, ok, err := st.ActiveByName(ctx, "alpha"); err != nil || !ok || a.Version != 3 {
		t.Fatalf("active alpha: %+v %v %v", a, ok, err)
	}
}
