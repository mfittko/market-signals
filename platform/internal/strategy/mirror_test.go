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

	// new engine versions are the only rows the next run inserts; after the delta v1 clash, delta v2 is skipped too;
	// alpha v4 is saved inactive, so it must leave the stored active alpha v3 active
	engineDB(t, path, [4]any{"alpha", 3, "alpha three", 1}, [4]any{"beta", 2, "beta two", 1}, [4]any{"delta", 1, "engine delta", 1}, [4]any{"delta", 2, "engine delta two", 1},
		[4]any{"alpha", 4, "alpha four", 0})
	rep, err := Mirror(ctx, pool, path)
	want = MirrorReport{Source: 9, Inserted: 3, Skipped: 3, Clashes: []Clash{{"gamma", 1}, {"delta", 1}, {"delta", 2}}, Recreated: []Clash{}}
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

func TestMirrorFollowsEngineActivationRollbackAndArchive(t *testing.T) {
	pool := testutil.Pool(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `TRUNCATE strategies`); err != nil {
		t.Fatal(err)
	}
	// alpha v5 exists only in the console; beta v1 is a console row with the engine's prompt; gamma v1 came in without an engine id
	if _, err := pool.Exec(ctx, `INSERT INTO strategies (name,version,prompt,created_by,created_at,active,archived,dedicated) VALUES
		('alpha',5,'console five','console',now(),true,false,false),
		('beta',1,'beta one','console',now(),false,false,false),
		('gamma',1,'gamma one','manual',now(),true,false,false)`); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "engine.db")
	engineDB(t, path, [4]any{"alpha", 1, "alpha one", 0}, [4]any{"alpha", 2, "alpha two", 0}, [4]any{"beta", 1, "beta one", 0}, [4]any{"gamma", 1, "gamma one", 0})
	engine, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close()

	for _, step := range []struct{ name, engine, console, active, archived string }{
		{name: "save", active: "alpha5"},
		{name: "activate", engine: `UPDATE strategies SET active=1 WHERE id IN (1,3)`, active: "alpha1"},
		{name: "activate a newer version", engine: `UPDATE strategies SET active=(id=2) WHERE name='alpha'`, active: "alpha2"},
		{name: "roll back", engine: `UPDATE strategies SET active=(id=1) WHERE name='alpha'`, active: "alpha1"},
		{name: "console activates its own version", console: `UPDATE strategies SET active=(version=5) WHERE name='alpha'`, active: "alpha1"},
		{name: "console activates an engine version", console: `UPDATE strategies SET active=(version=2) WHERE name='alpha'`, active: "alpha1"},
		{name: "archive", engine: `UPDATE strategies SET active=0, archived=1 WHERE id=1`, archived: "alpha1"},
		{name: "console restores", console: `UPDATE strategies SET archived=false WHERE name='alpha'`, archived: "alpha1"},
		{name: "recreate and activate", engine: `UPDATE strategies SET id=5, active=1 WHERE id=2`, active: "alpha2", archived: "alpha1"},
	} {
		if step.engine != "" {
			if _, err := engine.Exec(step.engine); err != nil {
				t.Fatal(err)
			}
		}
		if step.console != "" {
			if _, err := pool.Exec(ctx, step.console); err != nil {
				t.Fatal(err)
			}
		}
		if rep, err := Mirror(ctx, pool, path); err != nil || len(rep.Clashes) != 0 {
			t.Fatalf("%s: %+v %v", step.name, rep, err)
		}
		var active, archived string
		if err := pool.QueryRow(ctx, `SELECT COALESCE(string_agg(name||version, ' ' ORDER BY name, version) FILTER (WHERE active),''),
			COALESCE(string_agg(name||version, ' ' ORDER BY name, version) FILTER (WHERE archived),'') FROM strategies`).Scan(&active, &archived); err != nil || active != step.active || archived != step.archived {
			t.Fatalf("%s: active %q archived %q %v, want %q %q", step.name, active, archived, err, step.active, step.archived)
		}
	}
}

func TestMirrorNeverTouchesAClashedName(t *testing.T) {
	pool := testutil.Pool(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `TRUNCATE strategies`); err != nil {
		t.Fatal(err)
	}
	// alpha v1 is mirrored, alpha v2 clashes, alpha v4 lacks its engine id; Trend differs from the engine's trend only in case
	if _, err := pool.Exec(ctx, `INSERT INTO strategies (engine_id,name,version,prompt,created_by,created_at,active,archived,dedicated) VALUES
		(1,'alpha',1,'alpha one','manual',now(),false,false,false),
		(NULL,'alpha',2,'console two','console',now(),true,false,false),
		(NULL,'alpha',4,'alpha four','manual',now(),false,false,false),
		(NULL,'Trend',1,'trend one','console',now(),true,false,false)`); err != nil {
		t.Fatal(err)
	}
	snapshot := func() (s string) {
		t.Helper()
		if err := pool.QueryRow(ctx, `SELECT string_agg(s::text, ',' ORDER BY name, version) FROM strategies s`).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	before := snapshot()
	path := filepath.Join(t.TempDir(), "engine.db")
	// the engine activated alpha v1, which comes before the clash
	engineDB(t, path, [4]any{"alpha", 1, "alpha one", 1}, [4]any{"alpha", 2, "engine two", 0}, [4]any{"alpha", 3, "alpha three", 0}, [4]any{"alpha", 4, "alpha four", 0},
		[4]any{"trend", 1, "trend one", 1}, [4]any{"trend", 2, "trend two", 0})
	rep, err := Mirror(ctx, pool, path)
	want := MirrorReport{Source: 6, Clashes: []Clash{{"alpha", 1}, {"alpha", 2}, {"alpha", 3}, {"alpha", 4}, {"trend", 1}, {"trend", 2}}, Recreated: []Clash{}}
	if err != nil || !reflect.DeepEqual(rep, want) {
		t.Fatalf("%+v %v, want %+v", rep, err, want)
	}
	if after := snapshot(); after != before {
		t.Fatalf("a clashed name changed:\n%s\n%s", before, after)
	}
}
