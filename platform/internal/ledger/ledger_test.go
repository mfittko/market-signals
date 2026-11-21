package ledger

import (
	"context"
	"errors"
	"math"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mfittko/market-signals/platform/internal/testutil"
)

var (
	ctx = context.Background()
	t0  = time.Date(2026, 1, 5, 10, 0, 0, 0, time.UTC)
)

func f(v float64) *float64 { return &v }

func setup(t *testing.T, balance float64) *pgxpool.Pool {
	t.Helper()
	pool := testutil.Pool(t)
	if err := Seed(ctx, pool, balance, t0); err != nil {
		t.Fatal(err)
	}
	return pool
}

func mustOpen(t *testing.T, pool *pgxpool.Pool, key string, in OpenInput) int64 {
	t.Helper()
	if in.Instrument == "" {
		in.Instrument = "WTI"
	}
	if in.Side == "" {
		in.Side = "long"
	}
	id, err := Open(ctx, pool, key, in, t0)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

// dump renders every ledger table as JSON text, so two dumps compare the whole ledger.
func dump(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var out string
	for _, tbl := range []string{"ledger_account", "ledger_positions", "ledger_trades", "ledger_journal", "ledger_requests"} {
		var s string
		if err := pool.QueryRow(ctx, `SELECT COALESCE(json_agg(t ORDER BY t::text), '[]')::text FROM `+tbl+` t`).Scan(&s); err != nil {
			t.Fatal(err)
		}
		out += tbl + s + "\n"
	}
	return out
}

func count(t *testing.T, pool *pgxpool.Pool, sql string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(ctx, sql).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func cash(t *testing.T, pool *pgxpool.Pool) float64 {
	t.Helper()
	var c float64
	if err := pool.QueryRow(ctx, `SELECT cash FROM ledger_account`).Scan(&c); err != nil {
		t.Fatal(err)
	}
	return c
}

func near(t *testing.T, name string, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 1e-9 {
		t.Fatalf("%s = %v, want %v", name, got, want)
	}
}

func TestInjectedErrorLeavesLedgerUnchanged(t *testing.T) {
	injected := errors.New("injected")
	beforeCommit = func(string) error { return injected }
	t.Cleanup(func() { beforeCommit = nil })

	pool := testutil.Pool(t)
	before := dump(t, pool)
	if err := Seed(ctx, pool, 10000, t0); !errors.Is(err, injected) || dump(t, pool) != before {
		t.Fatalf("seed: err %v, or the ledger changed", err)
	}

	beforeCommit = nil
	if err := Seed(ctx, pool, 10000, t0); err != nil {
		t.Fatal(err)
	}
	a := mustOpen(t, pool, "a", OpenInput{Notional: 1000, Price: 100, Leverage: 10, Stop: 95})
	b := mustOpen(t, pool, "b", OpenInput{Notional: 1000, Price: 100, Leverage: 10, Stop: 95})
	beforeCommit = func(string) error { return injected }

	for name, op := range map[string]func() error{
		"open": func() error {
			_, err := Open(ctx, pool, "x1", OpenInput{Instrument: "WTI", Side: "short", Notional: 500, Price: 100, Leverage: 10, Stop: 105}, t0)
			return err
		},
		"close":   func() error { return Close(ctx, pool, "x2", a, 101, "manual", t0) },
		"partial": func() error { _, err := ClosePartial(ctx, pool, "x3", b, 4, 101, "manual", t0); return err },
		"fill": func() error {
			_, err := Fill(ctx, pool, "x4", a, Bar{Time: t0, Open: 96, High: 97, Low: 94})
			return err
		},
		"mark":  func() error { return Mark(ctx, pool, "x5", map[string]float64{"WTI": 80}, t0) },
		"halt":  func() error { return Halt(ctx, pool, "x6", "operator", t0) },
		"reset": func() error { return ResetHalt(ctx, pool, "x7", t0) },
	} {
		before := dump(t, pool)
		if err := op(); !errors.Is(err, injected) {
			t.Fatalf("%s: err = %v, want the injected error", name, err)
		}
		if after := dump(t, pool); after != before {
			t.Fatalf("%s changed the ledger:\n%s\n%s", name, before, after)
		}
	}
}

func TestSameKeyBooksOnce(t *testing.T) {
	pool := setup(t, 10000)
	in := OpenInput{Instrument: "WTI", Side: "long", Notional: 1000, Price: 100, Leverage: 10, Stop: 95}
	a, b := mustOpen(t, pool, "open-a", in), mustOpen(t, pool, "open-a", in)
	if a != b || count(t, pool, `SELECT count(*) FROM ledger_positions`) != 1 {
		t.Fatalf("open replay: ids %d %d", a, b)
	}
	for range 2 {
		if err := Close(ctx, pool, "close-a", a, 101, "manual", t0); err != nil {
			t.Fatal(err)
		}
	}
	c := mustOpen(t, pool, "open-c", in)
	for range 2 {
		if closed, err := Fill(ctx, pool, "fill-c", c, Bar{Time: t0, Open: 96, High: 97, Low: 94}); err != nil || !closed {
			t.Fatalf("fill replay: closed %v err %v", closed, err)
		}
	}
	if n := count(t, pool, `SELECT count(*) FROM ledger_trades`); n != 2 {
		t.Fatalf("trades = %d, want 2 (one per key)", n)
	}
	near(t, "cash", cash(t, pool), 10000+(101-100)*10+(95-100)*10)
	if _, err := Open(ctx, pool, "", in, t0); !errors.Is(err, ErrNoKey) {
		t.Fatalf("empty key: %v", err)
	}
	if err := Halt(ctx, pool, "open-a", "x", t0); !errors.Is(err, ErrInvalid) {
		t.Fatalf("key reused for another op: %v", err)
	}
}

func TestSecondCloseRefusedByUniqueKey(t *testing.T) {
	pool := setup(t, 10000)
	id := mustOpen(t, pool, "o", OpenInput{Notional: 1000, Price: 100, Leverage: 10, Stop: 95})
	if err := Close(ctx, pool, "c1", id, 101, "manual", t0); err != nil {
		t.Fatal(err)
	}
	c := cash(t, pool)
	err := Close(ctx, pool, "c2", id, 102, "manual", t0)
	var pe *pgconn.PgError
	if !errors.Is(err, ErrClosed) || !errors.As(err, &pe) || pe.Code != "23505" {
		t.Fatalf("second close: %v, want the unique violation", err)
	}
	if n := count(t, pool, `SELECT count(*) FROM ledger_trades`); n != 1 {
		t.Fatalf("trades = %d, want 1", n)
	}
	near(t, "cash", cash(t, pool), c)
}

func TestMoney(t *testing.T) {
	pool := setup(t, 10000)
	// Long: entry 100.1 (spread), 10 units, margin 100, commission 1 at open only.
	id := mustOpen(t, pool, "o1", OpenInput{Notional: 1000, Price: 100, Spread: 0.1, Leverage: 10, Commission: 1, Stop: 95})
	near(t, "cash after open", cash(t, pool), 9899)
	if err := Close(ctx, pool, "c1", id, 101, "manual", t0); err != nil {
		t.Fatal(err)
	}
	near(t, "cash after close", cash(t, pool), 9899+100+0.9*10)

	// Short partial: 4 of 10 units close at 95 as a child position.
	start := cash(t, pool)
	id = mustOpen(t, pool, "o2", OpenInput{Side: "short", Notional: 1000, Price: 100, Leverage: 10, Stop: 105})
	child, err := ClosePartial(ctx, pool, "p2", id, 4, 95, "manual", t0)
	if err != nil {
		t.Fatal(err)
	}
	var units, margin, notional float64
	var parent int64
	if err := pool.QueryRow(ctx, `SELECT units, margin, notional FROM ledger_positions WHERE id = $1`, id).Scan(&units, &margin, &notional); err != nil {
		t.Fatal(err)
	}
	near(t, "units", units, 6)
	near(t, "margin", margin, 60)
	near(t, "notional", notional, 600)
	if err := pool.QueryRow(ctx, `SELECT p.parent_id FROM ledger_trades t JOIN ledger_positions p ON p.id = t.position_id WHERE t.position_id = $1`, child).Scan(&parent); err != nil || parent != id {
		t.Fatalf("child trade: parent %d err %v", parent, err)
	}
	near(t, "cash after partial", cash(t, pool), start-100+40+20)
	if _, err := ClosePartial(ctx, pool, "p3", id, 6, 95, "manual", t0); !errors.Is(err, ErrInvalid) {
		t.Fatalf("partial of all units: %v", err)
	}

	// Fill uses fill.Check: a bar that misses both levels closes nothing; a stop touch fills at the stop.
	id = mustOpen(t, pool, "o3", OpenInput{Notional: 1000, Price: 100, Leverage: 10, Stop: 95, Target: f(110)})
	if closed, err := Fill(ctx, pool, "f3a", id, Bar{Time: t0, Open: 100, High: 101, Low: 99}); err != nil || closed {
		t.Fatalf("quiet bar: closed %v err %v", closed, err)
	}
	if closed, err := Fill(ctx, pool, "f3b", id, Bar{Time: t0.Add(time.Hour), Open: 96, High: 97, Low: 94}); err != nil || !closed {
		t.Fatalf("stop bar: closed %v err %v", closed, err)
	}
	var price float64
	var reason string
	if err := pool.QueryRow(ctx, `SELECT close_price, close_reason FROM ledger_trades WHERE position_id = $1`, id).Scan(&price, &reason); err != nil || price != 95 || reason != "stop" {
		t.Fatalf("fill trade: %v %q %v", price, reason, err)
	}
}

func TestMarginCloseHaltAndReset(t *testing.T) {
	pool := setup(t, 10000)
	// 900 units, margin 9000, cash 1000. At 88 the loss 10800 exceeds the margin and leaves equity < 0.
	mustOpen(t, pool, "o1", OpenInput{Notional: 90000, Price: 100, Leverage: 10, Stop: 50})
	if err := Mark(ctx, pool, "m1", map[string]float64{"WTI": 88, "XAU": 0}, t0); err != nil {
		t.Fatal(err)
	}
	if n := count(t, pool, `SELECT count(*) FROM ledger_trades WHERE close_reason = 'margin'`); n != 1 {
		t.Fatalf("margin closes = %d", n)
	}
	near(t, "cash", cash(t, pool), 1000+9000-10800)
	if n := count(t, pool, `SELECT count(*) FROM ledger_account WHERE halted`); n != 1 {
		t.Fatal("equity <= 0 did not halt")
	}
	if _, err := Open(ctx, pool, "o2", OpenInput{Instrument: "WTI", Side: "long", Notional: 1, Price: 100, Leverage: 10, Stop: 50}, t0); !errors.Is(err, ErrHalted) {
		t.Fatalf("open while halted: %v", err)
	}
	if err := ResetHalt(ctx, pool, "r1", t0); err != nil {
		t.Fatal(err)
	}
	if n := count(t, pool, `SELECT count(*) FROM ledger_account WHERE halted`); n != 0 {
		t.Fatal("reset did not clear the halt")
	}
}

func TestHaltClosesAtLastMark(t *testing.T) {
	pool := setup(t, 10000)
	id := mustOpen(t, pool, "o1", OpenInput{Notional: 1000, Price: 100, Leverage: 10, Stop: 90})
	if err := Mark(ctx, pool, "m1", map[string]float64{"WTI": 102}, t0); err != nil {
		t.Fatal(err)
	}
	if err := Halt(ctx, pool, "h1", "operator", t0); err != nil {
		t.Fatal(err)
	}
	var price float64
	if err := pool.QueryRow(ctx, `SELECT close_price FROM ledger_trades WHERE position_id = $1 AND close_reason = 'halt'`, id).Scan(&price); err != nil || price != 102 {
		t.Fatalf("halt close: %v %v", price, err)
	}
	near(t, "cash", cash(t, pool), 10000+20)
}
