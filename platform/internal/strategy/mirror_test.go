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
	// beta v1 came in through the one-shot import without an engine id; gamma v1 and delta v1 were written in the console
	for _, r := range [][2]string{{"beta", "beta rules"}, {"gamma", "console rules"}, {"delta", "console delta"}} {
		if _, err := pool.Exec(ctx, `INSERT INTO strategies (name,version,prompt,created_by,created_at,active,archived,dedicated) VALUES ($1,1,$2,'test',now(),true,false,false)`, r[0], r[1]); err != nil {
			t.Fatal(err)
		}
	}
	path := filepath.Join(t.TempDir(), "engine.db")
	engineDB(t, path, [4]any{"alpha", 1, "alpha one", 0}, [4]any{"alpha", 2, "alpha two", 1}, [4]any{"beta", 1, "beta rules", 1}, [4]any{"gamma", 1, "engine rules", 1})

	want := MirrorReport{Source: 4, Inserted: 2, Skipped: 1, Clashes: []Clash{{"gamma", 1}}, Recreated: []Clash{}}
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

	// new engine versions are the only rows the next run inserts; after the delta v1 clash, delta v2 is skipped too
	engineDB(t, path, [4]any{"alpha", 3, "alpha three", 1}, [4]any{"beta", 2, "beta two", 1}, [4]any{"delta", 1, "engine delta", 1}, [4]any{"delta", 2, "engine delta two", 1})
	rep, err := Mirror(ctx, pool, path)
	want = MirrorReport{Source: 8, Inserted: 2, Skipped: 3, Clashes: []Clash{{"gamma", 1}, {"delta", 1}, {"delta", 2}}, Recreated: []Clash{}}
	if err != nil || !reflect.DeepEqual(rep, want) {
		t.Fatalf("new version: %+v %v, want %+v", rep, err, want)
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM strategies WHERE name='delta'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("a clashing name got engine versions: %d %v", n, err)
	}
	// an inserted active version clears the stored active one: one active version per name
	for _, name := range []string{"alpha", "beta"} {
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM strategies WHERE name=$1 AND active`, name).Scan(&n); err != nil || n != 1 {
			t.Fatalf("active %s versions: %d %v", name, n, err)
		}
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
	// the newest inserted active version is the one active version
	for name, v := range map[string]int{"alpha": 3, "beta": 2} {
		if a, ok, err := st.ActiveByName(ctx, name); err != nil || !ok || a.Version != v {
			t.Fatalf("active %s: %+v %v %v", name, a, ok, err)
		}
	}
}

func TestMirrorReportsAnEngineIDStoredOnAnotherVersionAsAClash(t *testing.T) {
	pool := testutil.Pool(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `TRUNCATE strategies`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO strategies (engine_id,name,version,prompt,created_by,created_at,active,archived,dedicated) VALUES (1,'alpha',1,'alpha one','test',now(),false,false,false)`); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "engine.db")
	engineDB(t, path, [4]any{"alpha-renamed", 1, "alpha one", 0}) // engine row id 1 under another name
	rep, err := Mirror(ctx, pool, path)
	want := MirrorReport{Source: 1, Clashes: []Clash{{"alpha-renamed", 1}}, Recreated: []Clash{}}
	if err != nil || !reflect.DeepEqual(rep, want) {
		t.Fatalf("%+v %v, want %+v", rep, err, want)
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM strategies`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("rows: %d %v", n, err)
	}
}

func TestMirrorReportsARecreatedVersionAndKeepsImportingTheName(t *testing.T) {
	pool := testutil.Pool(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `TRUNCATE strategies`); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "engine.db")
	engineDB(t, path, [4]any{"alpha", 1, "alpha one", 0}, [4]any{"alpha", 2, "alpha two", 0}, [4]any{"beta", 1, "beta one", 0})
	if _, err := Mirror(ctx, pool, path); err != nil {
		t.Fatal(err)
	}
	// the engine deletes alpha v2 (id 2) and beta v1 (id 3) and saves them again under ids 4 and 5,
	// alpha with another prompt and beta with the same one, then saves alpha v3 (id 6)
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`DELETE FROM strategies WHERE id IN (2,3)`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	engineDB(t, path, [4]any{"alpha", 2, "alpha two b", 0}, [4]any{"beta", 1, "beta one", 0}, [4]any{"alpha", 3, "alpha three", 0})

	want := MirrorReport{Source: 4, Inserted: 1, Skipped: 1, Clashes: []Clash{}, Recreated: []Clash{{"alpha", 2}, {"beta", 1}}}
	rep, err := Mirror(ctx, pool, path)
	if err != nil || !reflect.DeepEqual(rep, want) {
		t.Fatalf("%+v %v, want %+v", rep, err, want)
	}
	st := Store{pool}
	// the same prompt moves the engine id; another prompt keeps the stored row and its old id
	for id, name := range map[int64]string{1: "alpha", 2: "alpha", 5: "beta", 6: "alpha"} {
		if n, ok, err := st.NameByEngineID(ctx, id); err != nil || !ok || n != name {
			t.Fatalf("engine id %d: %q %v %v", id, n, ok, err)
		}
	}
	for _, id := range []int64{3, 4} {
		if _, ok, err := st.NameByEngineID(ctx, id); ok || err != nil {
			t.Fatalf("engine id %d is mapped: %v %v", id, ok, err)
		}
	}
	// a rerun reports only the recreated version whose prompt differs
	want = MirrorReport{Source: 4, Skipped: 3, Clashes: []Clash{}, Recreated: []Clash{{"alpha", 2}}}
	if rep, err := Mirror(ctx, pool, path); err != nil || !reflect.DeepEqual(rep, want) {
		t.Fatalf("rerun: %+v %v, want %+v", rep, err, want)
	}
}
