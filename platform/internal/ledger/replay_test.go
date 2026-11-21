package ledger

import (
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mfittko/market-signals/platform/internal/db"
	"github.com/mfittko/market-signals/platform/internal/testutil"
)

var m5 = "M5"

// bar returns the time of the i-th M5 bar after t0.
func bar(i int) time.Time { return t0.Add(time.Duration(i) * 5 * time.Minute) }

// candles replaces the stored WTI M5 candles with rows {i, open, high, low}, timed bar(i).
func candles(t *testing.T, pool *pgxpool.Pool, rows ...[4]float64) {
	t.Helper()
	if _, err := pool.Exec(ctx, `DELETE FROM candles WHERE instrument = 'WTI' AND granularity = 'M5'`); err != nil {
		t.Fatal(err)
	}
	for _, r := range rows {
		if _, err := pool.Exec(ctx, `INSERT INTO candles VALUES ('WTI', 'M5', $1, $2, $3, $4, $2, NULL)`,
			bar(int(r[0])), r[1], r[2], r[3]); err != nil {
			t.Fatal(err)
		}
	}
}

func replay(t *testing.T, pool *pgxpool.Pool, key string, id int64, through time.Time) bool {
	t.Helper()
	closed, err := Replay(ctx, pool, key, id, through)
	if err != nil {
		t.Fatal(err)
	}
	return closed
}

func lastJudged(t *testing.T, pool *pgxpool.Pool, id int64) time.Time {
	t.Helper()
	var at time.Time
	if err := pool.QueryRow(ctx, `SELECT last_judged_at FROM ledger_positions WHERE id = $1`, id).Scan(&at); err != nil {
		t.Fatal(err)
	}
	return at
}

func trade(t *testing.T, pool *pgxpool.Pool, id int64) (price float64, at time.Time, reason string) {
	t.Helper()
	if err := pool.QueryRow(ctx, `SELECT close_price, close_time, close_reason FROM ledger_trades WHERE position_id = $1`, id).
		Scan(&price, &at, &reason); err != nil {
		t.Fatal(err)
	}
	return price, at, reason
}

// A stop touched in a bar between two evaluations fills at that bar's time and stop price, not at the newest bar.
func TestReplayFillsTheBarBetweenEvaluations(t *testing.T) {
	pool := setup(t, 10000)
	id := mustOpen(t, pool, "o", OpenInput{Notional: 1000, Price: 100, Leverage: 10, Stop: 95, Granularity: &m5})
	candles(t, pool,
		[4]float64{-1, 100, 101, 90}, // before the entry: never judged
		[4]float64{0, 100, 101, 99},
		[4]float64{1, 99, 100, 94}, // stop touched intrabar
		[4]float64{2, 96, 98, 96},
		[4]float64{3, 96, 97, 80}, // after through: not judged yet
	)
	if replay(t, pool, "r1", id, bar(0)) || !lastJudged(t, pool, id).Equal(bar(0)) {
		t.Fatal("first evaluation closed the position or stored the wrong last judged bar")
	}
	if !replay(t, pool, "r2", id, bar(2)) {
		t.Fatal("second evaluation did not fill the stop touched between evaluations")
	}
	price, at, reason := trade(t, pool, id)
	if price != 95 || !at.Equal(bar(1)) || reason != "stop" {
		t.Fatalf("fill at %v %v %q, want 95 at %v stop", price, at, reason, bar(1))
	}
	near(t, "cash", cash(t, pool), 10000+(95-100)*10)
	if !lastJudged(t, pool, id).Equal(bar(1)) {
		t.Fatal("last judged bar is not the fill bar")
	}
	// The same key replays the stored result; a closed position refuses a new key.
	if !replay(t, pool, "r2", id, bar(3)) || count(t, pool, `SELECT count(*) FROM ledger_trades`) != 1 {
		t.Fatal("replayed key booked again")
	}
	if _, err := Replay(ctx, pool, "r3", id, bar(3)); !errors.Is(err, ErrClosed) {
		t.Fatalf("replay of a closed position: %v, want ErrClosed", err)
	}
}

// After a restart (a new connection pool) the stored last judged bar survives: bars already judged are not
// judged again, even when a stored candle changed, and the first bar after it is judged.
func TestReplayAfterRestart(t *testing.T) {
	pool := setup(t, 10000)
	id := mustOpen(t, pool, "o", OpenInput{Side: "short", Notional: 1000, Price: 100, Leverage: 10, Stop: 105, Target: f(90), Granularity: &m5})
	candles(t, pool, [4]float64{0, 100, 102, 99}, [4]float64{1, 101, 103, 100})
	if replay(t, pool, "r1", id, bar(1)) {
		t.Fatal("quiet bars closed the position")
	}

	url, err := testutil.DatabaseURL()
	if err != nil {
		t.Fatal(err)
	}
	restarted, err := db.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(restarted.Close)
	// Bar 1 is rewritten to touch the stop after it was judged; bar 2 is the first bar after the restart.
	candles(t, restarted, [4]float64{0, 100, 102, 99}, [4]float64{1, 101, 106, 100}, [4]float64{2, 100, 101, 89})
	if !lastJudged(t, restarted, id).Equal(bar(1)) {
		t.Fatal("last judged bar did not survive the restart")
	}
	if !replay(t, restarted, "r2", id, bar(2)) {
		t.Fatal("the first bar after the restart was not judged")
	}
	price, at, reason := trade(t, restarted, id)
	if price != 90 || !at.Equal(bar(2)) || reason != "target" {
		t.Fatalf("fill at %v %v %q, want 90 at %v target (bar 1 judged twice?)", price, at, reason, bar(2))
	}
}

// A position without granularity and a stored candle that fails the bar checks are refused and write nothing.
func TestReplayRefusals(t *testing.T) {
	pool := setup(t, 10000)
	plain := mustOpen(t, pool, "o1", OpenInput{Notional: 1000, Price: 100, Leverage: 10, Stop: 95})
	if _, err := Replay(ctx, pool, "r1", plain, bar(1)); !errors.Is(err, ErrInvalid) {
		t.Fatalf("replay without granularity: %v, want ErrInvalid", err)
	}
	id := mustOpen(t, pool, "o2", OpenInput{Notional: 1000, Price: 100, Leverage: 10, Stop: 95, Granularity: &m5})
	candles(t, pool, [4]float64{0, 100, 101, 99}, [4]float64{1, 120, 101, 99})
	before := dump(t, pool)
	if _, err := Replay(ctx, pool, "r2", id, bar(1)); !errors.Is(err, ErrInvalid) {
		t.Fatalf("replay over a bad candle: %v, want ErrInvalid", err)
	}
	if after := dump(t, pool); after != before {
		t.Fatalf("refused replay changed the ledger:\n%s\n%s", before, after)
	}
}
