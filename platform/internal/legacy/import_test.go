package legacy

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	"github.com/mfittko/market-signals/platform/internal/testutil"
)

const fixtureDDL = `
CREATE TABLE candles (instrument TEXT, granularity TEXT, time TEXT, open REAL, high REAL, low REAL, close REAL, volume REAL);
CREATE TABLE signals (instrument TEXT, granularity TEXT, time TEXT, signal TEXT, price REAL, win_rate REAL, verdict TEXT, reason TEXT, notified INTEGER, kind TEXT);
CREATE TABLE signal_snapshots (instrument TEXT, granularity TEXT, time TEXT, schema_version INTEGER, snapshot TEXT, filter_verdict TEXT, filter_model TEXT, filter_prompt_hash TEXT, context TEXT, filter_prompt_version TEXT);
CREATE TABLE strategies (id INTEGER PRIMARY KEY, name TEXT, version INTEGER, prompt TEXT, spec TEXT, instruments TEXT, created_by TEXT, created_at TEXT, active INTEGER, archived INTEGER, instrument TEXT, granularity TEXT, dedicated INTEGER);
CREATE TABLE bot_trades (id INTEGER PRIMARY KEY, position_id INTEGER, instrument TEXT, side TEXT, notional REAL, units REAL, entry_price REAL, entry_time TEXT, close_price REAL, close_time TEXT, leverage REAL, realized REAL, close_reason TEXT, granularity TEXT);
CREATE TABLE bot_journal (id INTEGER PRIMARY KEY, at TEXT, action TEXT, position_id INTEGER, reason TEXT, context TEXT);
CREATE TABLE portfolio (id INTEGER PRIMARY KEY, starting_balance REAL, cash REAL, halted INTEGER, created_at TEXT);
CREATE TABLE bot_state (key TEXT PRIMARY KEY, value REAL);
CREATE TABLE positions (id INTEGER PRIMARY KEY);
CREATE TABLE chat_threads (id INTEGER PRIMARY KEY, title TEXT, created_at TEXT, instrument TEXT, granularity TEXT);
CREATE TABLE chat_messages (id INTEGER PRIMARY KEY, thread_id INTEGER, role TEXT, content TEXT, context TEXT, created_at TEXT);
CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT, weight INTEGER, source TEXT, created_at TEXT, updated_at TEXT, archived INTEGER);
CREATE TABLE gate_prompts (id INTEGER PRIMARY KEY, gate TEXT, version INTEGER, prompt TEXT, created_by TEXT, created_at TEXT, active INTEGER);
CREATE TABLE signal_rechecks (id INTEGER PRIMARY KEY, signal_time TEXT, instrument TEXT, granularity TEXT, at TEXT, verdict TEXT, reason TEXT, prompt_version TEXT);

INSERT INTO candles VALUES ('WTICO/USD','M5','2026-07-22T07:40:00.000000000Z',1,2,1,1.5,10),('WTICO/USD','M5','2026-07-22T07:45:00.000000000Z',1.5,2,1,1.6,NULL),('XAU/USD','M5','2026-07-22T07:40:00.000000000Z',9,9,9,9,1);
INSERT INTO signals VALUES ('WTICO/USD','M5','2026-07-22T07:40:00.000Z','sell',1.5,0.5,'valid','x',1,'supertrend-flip');
INSERT INTO strategies VALUES (1,'wti-s',1,'prompt',NULL,NULL,'manual','2026-07-01T00:00:00.000Z',1,0,'WTICO/USD','M5',1);
INSERT INTO bot_journal VALUES (1,'2026-07-22T08:00:00.000Z','open',7,'go','{"strategyVersion":"abc123"}'),(2,'2026-07-22T09:00:00.000Z','close',7,'done',NULL);
INSERT INTO bot_trades VALUES (1,7,'WTICO/USD','long',1000,10,1.5,'2026-07-22T08:00:00.000Z',1.6,'2026-07-22T09:00:00.000Z',20,1.0,'target','M5');
INSERT INTO portfolio VALUES (1,100,101,0,'2026-07-01T00:00:00.000Z');
INSERT INTO chat_threads VALUES (1,'t','2026-07-01T00:00:00.000Z',NULL,NULL);
INSERT INTO chat_messages VALUES (1,1,'user','hi',NULL,'2026-07-01T00:00:00.000Z'),(2,99,'user','orphan',NULL,'2026-07-01T00:00:00.000Z');
`

func fixture(t *testing.T, cash float64) Options {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "candles.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(fixtureDDL); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE portfolio SET cash=?`, cash); err != nil {
		t.Fatal(err)
	}
	settings := filepath.Join(dir, "settings.json")
	if err := os.WriteFile(settings, []byte(`{"OPENAI_API_KEY":"never-read","bot":{"bots":{"WTICO/USD|M5":{"enabled":true,"strategyName":"wti-s"}}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	return Options{SQLitePath: path, SettingsPath: settings, SymbolsPath: filepath.Join(dir, "none.json")}
}

func TestImportIsIdempotentAndChecksTheBooks(t *testing.T) {
	pool := testutil.Pool(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `TRUNCATE candles, signals, signal_snapshots, strategies, trades, bot_journal, portfolio_account, chat_threads, standing_rules, prompt_versions, rechecks, instruments CASCADE; DELETE FROM agents WHERE legacy_bot`); err != nil {
		t.Fatal(err)
	}

	// cash 102 does not equal start 100 + realized 1: the books do not reconcile, so nothing may commit
	bad, err := Run(ctx, pool, fixture(t, 102))
	if err != nil {
		t.Fatal(err)
	}
	if bad.OK() || bad.Committed {
		t.Fatalf("a mismatch must block the commit: %+v", bad.Invariants)
	}
	var n int
	pool.QueryRow(ctx, `SELECT count(*) FROM candles`).Scan(&n)
	if n != 0 {
		t.Fatalf("a blocked import must leave nothing behind, found %d candles", n)
	}

	opts := fixture(t, 101)
	dry := opts
	dry.DryRun = true
	if r, err := Run(ctx, pool, dry); err != nil || !r.OK() || r.Committed {
		t.Fatalf("dry run: %v %+v", err, r)
	}
	pool.QueryRow(ctx, `SELECT count(*) FROM candles`).Scan(&n)
	if n != 0 {
		t.Fatal("a dry run must not write")
	}

	first, err := Run(ctx, pool, opts)
	if err != nil || !first.Committed {
		t.Fatalf("first import: %v %+v", err, first)
	}
	if first.Tables["candles"].Inserted != 3 || first.Tables["chat_messages"].Source != 1 {
		t.Fatalf("unexpected counts (the orphan message must be left out): %+v", first.Tables)
	}
	second, err := Run(ctx, pool, opts)
	if err != nil || !second.Committed {
		t.Fatalf("second import: %v", err)
	}
	for name, tr := range second.Tables {
		if tr.Inserted != 0 {
			t.Fatalf("re-run inserted %d rows into %s", tr.Inserted, name)
		}
	}
	var hash string
	pool.QueryRow(ctx, `SELECT strategy_hash FROM trades`).Scan(&hash)
	if hash != "abc123" {
		t.Fatalf("trade must link to the strategy version recorded when it opened, got %q", hash)
	}
	pool.QueryRow(ctx, `SELECT count(*) FROM agents WHERE legacy_bot`).Scan(&n)
	if n != 1 {
		t.Fatalf("one llm agent per bot, got %d", n)
	}
	var llmOn bool
	pool.QueryRow(ctx, `SELECT enabled FROM agents WHERE id='legacy-wtico-usd-m5-llm'`).Scan(&llmOn)
	if llmOn {
		t.Fatal("the LLM twin must start disabled so an import never spends money")
	}
}
