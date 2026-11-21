package ledger

import (
	"database/sql"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mfittko/market-signals/platform/internal/testutil"
)

// The Node paper book schema (scripts/portfolio.mjs), with last_mark_at as Node adds it later.
const nodeDDL = `CREATE TABLE portfolio (id INTEGER PRIMARY KEY CHECK (id = 1), starting_balance REAL NOT NULL,
  cash REAL NOT NULL, halted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE positions (id INTEGER PRIMARY KEY AUTOINCREMENT, instrument TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long','short')), notional REAL NOT NULL, units REAL NOT NULL,
  entry_price REAL NOT NULL, entry_time TEXT NOT NULL, leverage REAL NOT NULL, margin REAL NOT NULL,
  stop REAL, target REAL, last_mark REAL NOT NULL, stale INTEGER NOT NULL DEFAULT 0, granularity TEXT,
  last_mark_at TEXT)`

// Two clean positions: equity = 9850 + (100 + 20) + (50 - 5) = 10015.
var cleanPositions = []string{
	`(1, 'WTI', 'long', 1000, 10, 100, '2026-01-05T10:00:00.000Z', 10, 100, 95, 110, 102, 'M5', NULL)`,
	`(2, 'BRENT', 'short', 500, 5, 100, '2026-01-05T10:05:00.000Z', 10, 50, 105, NULL, 101, NULL, '2026-01-05T11:00:00.000Z')`,
}

// nodeBook writes a temporary Node paper book with the given cash and position rows.
func nodeBook(t *testing.T, cash float64, positions ...string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "book.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	stmts := []string{nodeDDL, `INSERT INTO portfolio VALUES (1, 10000, ?, 0, '2026-01-05T09:00:00.000Z')`}
	for _, p := range positions {
		stmts = append(stmts, `INSERT INTO positions (id, instrument, side, notional, units, entry_price, entry_time,
			leverage, margin, stop, target, last_mark, granularity, last_mark_at) VALUES `+p)
	}
	for i, s := range stmts {
		var args []any
		if i == 1 {
			args = []any{cash}
		}
		if _, err := db.Exec(s, args...); err != nil {
			t.Fatal(err)
		}
	}
	return path
}

func importNode(t *testing.T, pool *pgxpool.Pool, path string, commit bool) *ImportReport {
	t.Helper()
	rep, err := ImportNode(ctx, pool, path, commit, t0)
	if err != nil {
		t.Fatal(err)
	}
	return rep
}

func hasDifference(rep *ImportReport, parts ...string) bool {
	for _, d := range rep.Differences {
		all := true
		for _, p := range parts {
			all = all && strings.Contains(d, p)
		}
		if all {
			return true
		}
	}
	return false
}

func TestImportNodeReconciles(t *testing.T) {
	pool := testutil.Pool(t)
	rep := importNode(t, pool, nodeBook(t, 9850, cleanPositions...), true)
	if !rep.OK() || !rep.Committed || !rep.AccountCreated || rep.Booked != 2 {
		t.Fatalf("report %+v", rep)
	}
	if rep.Go != rep.Node {
		t.Fatalf("go %+v, node %+v", rep.Go, rep.Node)
	}
	near(t, "equity", rep.Go.Equity, 10015)
	near(t, "cash", cash(t, pool), 9850)
	if n := count(t, pool, `SELECT count(*) FROM ledger_positions WHERE closed_at IS NULL AND last_judged_at IS NULL`); n != 2 {
		t.Fatalf("open positions = %d", n)
	}
}

func TestImportNodeDryRunChangesNothing(t *testing.T) {
	pool := testutil.Pool(t)
	before := dump(t, pool)
	rep := importNode(t, pool, nodeBook(t, 9850, cleanPositions...), false)
	if rep.Committed || !rep.OK() || rep.Booked != 2 {
		t.Fatalf("the dry run reports the would-be result: %+v", rep)
	}
	if dump(t, pool) != before {
		t.Fatal("the dry run changed the ledger")
	}
}

func TestImportNodeTwiceBooksNothingNew(t *testing.T) {
	pool := testutil.Pool(t)
	path := nodeBook(t, 9850, cleanPositions...)
	importNode(t, pool, path, true)
	before := dump(t, pool)
	rep := importNode(t, pool, path, true)
	if rep.Booked != 0 || rep.AlreadyImported != 2 || rep.AccountCreated || !rep.OK() {
		t.Fatalf("second import %+v", rep)
	}
	if dump(t, pool) != before {
		t.Fatal("the second import changed the ledger")
	}
	// A booked position that Go closed since is listed as missing, and a changed field as a mismatch.
	if err := Close(ctx, pool, "c", 1, 101, "manual", t0); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE ledger_positions SET stop = 106 WHERE id = 2`); err != nil {
		t.Fatal(err)
	}
	rep = importNode(t, pool, path, false)
	if !hasDifference(rep, "node position 1 WTI long", "missing from go") ||
		!hasDifference(rep, "node position 2 BRENT short: go position 2 stop: node 105, go 106") {
		t.Fatalf("differences %q", rep.Differences)
	}
}

func TestImportNodeRefusesNoStop(t *testing.T) {
	pool := testutil.Pool(t)
	noStop := `(3, 'GOLD', 'long', 1000, 1, 1000, '2026-01-05T10:10:00.000Z', 10, 100, NULL, NULL, 1000, 'M5', NULL)`
	rep := importNode(t, pool, nodeBook(t, 9750, append(cleanPositions, noStop)...), true)
	if rep.Refused != 1 || rep.Booked != 2 {
		t.Fatalf("report %+v", rep)
	}
	for _, want := range [][]string{{"node position 3 GOLD long refused", "no stop"}, {"equity: node 10015, go 9915"}, {"open positions: node 3, go 2"}} {
		if !hasDifference(rep, want...) {
			t.Fatalf("no difference %q in %q", want, rep.Differences)
		}
	}
}

func TestImportNodeRefusesTargetNotBeyondEntry(t *testing.T) {
	pool := testutil.Pool(t)
	atEntry := `(4, 'WTI', 'long', 1000, 10, 100, '2026-01-05T10:00:00.000Z', 10, 100, 95, 100, 100, 'M5', NULL)`
	rep := importNode(t, pool, nodeBook(t, 9900, atEntry), true)
	if rep.Refused != 1 || rep.Booked != 0 || !hasDifference(rep, "node position 4 WTI long refused", "target does not lie beyond") {
		t.Fatalf("report %+v", rep)
	}
}

func TestImportNodeShowsExistingAccountDifferences(t *testing.T) {
	pool := setup(t, 10000)
	extra := mustOpen(t, pool, "x", OpenInput{Notional: 1000, Price: 100, Leverage: 10, Stop: 95})
	rep := importNode(t, pool, nodeBook(t, 9850, cleanPositions...), true)
	if rep.AccountCreated {
		t.Fatal("an existing account must be left alone")
	}
	if !hasDifference(rep, "cash: node 9850, go 9900") || !hasDifference(rep, "go position", "is open and not in the node book") {
		t.Fatalf("differences %q (extra position %d)", rep.Differences, extra)
	}
}

// Runs without Postgres: the Node reader and each refusal rule.
func TestNodeBookReadAndRefusals(t *testing.T) {
	row := func(id int, side, stop, target, entryTime string) string {
		return "(" + strconv.Itoa(id) + ", 'WTI', '" + side + "', 1000, 10, 100, '" + entryTime + "', 10, 100, " + stop + ", " + target + ", 100, 'M5', NULL)"
	}
	ok := "2026-01-05T10:00:00.000Z"
	acct, nodes, err := readNodeBook(nodeBook(t, 9850,
		row(1, "long", "95", "110", ok),
		row(2, "short", "105", "NULL", ok),
		row(3, "long", "NULL", "NULL", ok),
		row(4, "long", "101", "NULL", ok),
		row(5, "short", "99", "NULL", ok),
		row(6, "long", "95", "100", ok),
		row(7, "short", "105", "100", ok),
		row(8, "long", "95", "NULL", "yesterday"),
		row(9, "long", "-1", "NULL", ok),
	))
	if err != nil {
		t.Fatal(err)
	}
	if acct.cash != 9850 || acct.startingBalance != 10000 || acct.halted || acct.createdAt.IsZero() || len(nodes) != 9 {
		t.Fatalf("account %+v, %d positions", acct, len(nodes))
	}
	want := []string{"", "", "no stop", "loss side", "loss side", "beyond the entry", "beyond the entry", "entry time", "stop must be > 0"}
	for i, n := range nodes {
		got := n.refusal()
		if (want[i] == "") != (got == "") || !strings.Contains(got, want[i]) {
			t.Fatalf("position %d: refusal %q, want %q", n.id, got, want[i])
		}
	}
	if !nodes[0].markAt.Equal(nodes[0].entryAt) || nodes[0].key() != "node-import:position:1:"+ok {
		t.Fatalf("mark time falls back to the entry time; key %q", nodes[0].key())
	}
}
