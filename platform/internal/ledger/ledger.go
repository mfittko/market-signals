// Package ledger is the Go paper ledger in Postgres. Every keyed operation (all but Seed)
// runs in one transaction under a row lock on the account and records its idempotency key
// with its target position, so a failed operation writes nothing and a repeated key books
// nothing twice. Seed takes no key: it is idempotent through ON CONFLICT DO NOTHING on the
// single account row. The money rules follow the Node ledger in scripts/portfolio.mjs.
package ledger

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mfittko/market-signals/platform/internal/domain"
	"github.com/mfittko/market-signals/platform/internal/fill"
)

var (
	ErrNoKey     = errors.New("ledger: idempotency key required")
	ErrNoAccount = errors.New("ledger: no account (run Seed first)")
	ErrHalted    = errors.New("ledger: account halted")
	ErrInvalid   = errors.New("ledger: invalid input")
	ErrClosed    = errors.New("ledger: position already closed")
)

// beforeCommit runs after an operation's writes and before its commit. Tests set it to inject an error.
var beforeCommit func(op string) error

func commitHook(op string) error {
	if beforeCommit == nil {
		return nil
	}
	return beforeCommit(op)
}

// OpenInput is one position request. Sizing caps (risk, allocation, max positions) are caller policy.
type OpenInput struct {
	Instrument, Side                                    string
	Notional, Price, Spread, Leverage, Commission, Stop float64
	Target                                              *float64
	Granularity                                         *string
}

// Bar is the part of one candle that fill.Check reads.
type Bar struct {
	Time            time.Time
	Open, High, Low float64
}

type position struct {
	id                                                       int64
	instrument, side                                         string
	notional, units, entry, leverage, margin, stop, lastMark float64
	target                                                   *float64
	entryTime                                                time.Time
	granularity                                              *string
	closed                                                   bool
}

// unrealized is the profit of p at mark; commission is charged once, at open.
func unrealized(side string, entry, units, mark float64) float64 {
	if side == "long" {
		return (mark - entry) * units
	}
	return (entry - mark) * units
}

func positive(v float64) bool { return v > 0 && !math.IsInf(v, 1) }

func invalid(msg string) error { return fmt.Errorf("%w: %s", ErrInvalid, msg) }

// errNoTime refuses a zero operation time, which would book rows dated 0001-01-01.
var errNoTime = invalid("operation time required")

// Seed creates the account with startingBalance when it does not exist yet.
func Seed(ctx context.Context, pool *pgxpool.Pool, startingBalance float64, at time.Time) error {
	if !positive(startingBalance) {
		return invalid("starting balance must be > 0")
	}
	if at.IsZero() {
		return errNoTime
	}
	return pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `INSERT INTO ledger_account (id, starting_balance, cash, created_at) VALUES (1, $1, $1, $2)
			ON CONFLICT DO NOTHING`, startingBalance, at)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 1 {
			if err := journal(ctx, tx, at, "init", nil, "", "", map[string]any{"startingBalance": startingBalance}); err != nil {
				return err
			}
		}
		return commitHook("seed")
	})
}

// run applies body once per idempotency key. A known key replays the stored position id and writes nothing.
// The key is bound to op and target (the requested position, nil for account-wide ops); a replay for another
// op or target is refused.
func run(ctx context.Context, pool *pgxpool.Pool, op, key string, target *int64, body func(tx pgx.Tx, halted bool) (*int64, error)) (*int64, error) {
	if strings.TrimSpace(key) == "" {
		return nil, ErrNoKey
	}
	var out *int64
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		var halted bool
		err := tx.QueryRow(ctx, `SELECT halted FROM ledger_account WHERE id = 1 FOR UPDATE`).Scan(&halted)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNoAccount
		} else if err != nil {
			return err
		}
		err = tx.QueryRow(ctx, `INSERT INTO ledger_requests (idempotency_key, op, target_id) VALUES ($1, $2, $3)
			ON CONFLICT DO NOTHING RETURNING true`, key, op, target).Scan(new(bool))
		if errors.Is(err, pgx.ErrNoRows) {
			var stored string
			var storedTarget *int64
			if err := tx.QueryRow(ctx, `SELECT op, target_id, position_id FROM ledger_requests WHERE idempotency_key = $1`, key).Scan(&stored, &storedTarget, &out); err != nil {
				return err
			}
			if stored != op {
				return invalid(fmt.Sprintf("idempotency key %q was used for %s", key, stored))
			}
			if (storedTarget == nil) != (target == nil) || (target != nil && *storedTarget != *target) {
				return invalid(fmt.Sprintf("idempotency key %q was used for another position", key))
			}
			return nil
		} else if err != nil {
			return err
		}
		if out, err = body(tx, halted); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE ledger_requests SET position_id = $2 WHERE idempotency_key = $1`, key, out); err != nil {
			return err
		}
		return commitHook(op)
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// Open books a position and returns its id. A replayed key returns the same id.
func Open(ctx context.Context, pool *pgxpool.Pool, key string, in OpenInput, at time.Time) (int64, error) {
	switch {
	case strings.TrimSpace(in.Instrument) == "":
		return 0, invalid("instrument required")
	case in.Side != "long" && in.Side != "short":
		return 0, invalid("side must be long|short")
	case !positive(in.Notional) || !positive(in.Price):
		return 0, invalid("notional and price must be > 0")
	case !positive(in.Leverage):
		return 0, invalid("leverage must be > 0")
	case !positive(in.Stop) || (in.Target != nil && !positive(*in.Target)):
		return 0, invalid("stop must be > 0, and target when set")
	case in.Side == "long" && (!(in.Stop < in.Price) || (in.Target != nil && !(*in.Target > in.Price))),
		in.Side == "short" && (!(in.Stop > in.Price) || (in.Target != nil && !(*in.Target < in.Price))):
		return 0, invalid("stop and target must be on the loss and profit side of the price")
	case !(in.Spread >= 0) || math.IsInf(in.Spread, 1) || !(in.Commission >= 0) || math.IsInf(in.Commission, 1):
		return 0, invalid("spread and commission must be >= 0")
	case !(in.Spread < in.Price):
		return 0, invalid("spread must be below the price")
	// The entry bar is judged with the entry as its open, so a target at or before the entry would gap-fill at once.
	case in.Target != nil && (in.Side == "long" && !(*in.Target > in.Price+in.Spread) ||
		in.Side == "short" && !(*in.Target < in.Price-in.Spread)):
		return 0, invalid("target must lie beyond the entry price after spread")
	case at.IsZero():
		return 0, errNoTime
	}
	instrument := strings.TrimSpace(in.Instrument)
	id, err := run(ctx, pool, "open", key, nil, func(tx pgx.Tx, halted bool) (*int64, error) {
		if halted {
			return nil, ErrHalted
		}
		margin := in.Notional / in.Leverage
		tag, err := tx.Exec(ctx, `UPDATE ledger_account SET cash = cash - $1 WHERE id = 1 AND cash >= $1`, margin+in.Commission)
		if err != nil {
			return nil, err
		}
		if tag.RowsAffected() == 0 {
			return nil, invalid("insufficient cash for margin + commission")
		}
		entry := in.Price + in.Spread
		if in.Side == "short" {
			entry = in.Price - in.Spread
		}
		var id int64
		if err := tx.QueryRow(ctx, `INSERT INTO ledger_positions (instrument, side, notional, units, entry_price, entry_time,
			leverage, margin, stop, target, last_mark, last_mark_at, granularity)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $6, $12) RETURNING id`,
			instrument, in.Side, in.Notional, in.Notional/in.Price, entry, at, in.Leverage, margin, in.Stop, in.Target,
			in.Price, in.Granularity).Scan(&id); err != nil {
			return nil, err
		}
		return &id, journal(ctx, tx, at, "open", &id, "", key, map[string]any{
			"price": in.Price, "entry": entry, "spread": in.Spread, "margin": margin, "commission": in.Commission})
	})
	if err != nil {
		return 0, err
	}
	return *id, nil
}

// Close closes a position at price. A second close of the same position fails with ErrClosed.
func Close(ctx context.Context, pool *pgxpool.Pool, key string, positionID int64, price float64, reason string, at time.Time) error {
	if !positive(price) || strings.TrimSpace(reason) == "" {
		return invalid("close needs a price > 0 and a reason")
	}
	if at.IsZero() {
		return errNoTime
	}
	_, err := run(ctx, pool, "close", key, &positionID, func(tx pgx.Tx, _ bool) (*int64, error) {
		p, err := load(ctx, tx, positionID)
		if err != nil {
			return nil, err
		}
		return &p.id, closeIn(ctx, tx, key, p, price, reason, at)
	})
	return err
}

// ClosePartial closes units of a position. The closed part becomes a child position
// (parent_id set) with proportional notional and margin, so each trade maps to one position.
func ClosePartial(ctx context.Context, pool *pgxpool.Pool, key string, positionID int64, units, price float64, reason string, at time.Time) (int64, error) {
	if !positive(price) || strings.TrimSpace(reason) == "" {
		return 0, invalid("close needs a price > 0 and a reason")
	}
	if at.IsZero() {
		return 0, errNoTime
	}
	id, err := run(ctx, pool, "close_partial", key, &positionID, func(tx pgx.Tx, _ bool) (*int64, error) {
		p, err := load(ctx, tx, positionID)
		if err != nil {
			return nil, err
		}
		if p.closed {
			return nil, ErrClosed
		}
		if !(units > 0 && units < p.units) {
			return nil, invalid("partial units must be > 0 and below the position units")
		}
		frac := units / p.units
		child := p
		child.notional, child.units, child.margin = p.notional*frac, units, p.margin*frac
		if err := tx.QueryRow(ctx, `INSERT INTO ledger_positions (instrument, side, notional, units, entry_price, entry_time,
			leverage, margin, stop, target, last_mark, last_mark_at, granularity, parent_id)
			SELECT instrument, side, $2::float8, $3::float8, entry_price, entry_time, leverage, $4::float8, stop, target, last_mark, last_mark_at, granularity, id
			FROM ledger_positions WHERE id = $1 RETURNING id`, p.id, child.notional, child.units, child.margin).Scan(&child.id); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `UPDATE ledger_positions SET units = units - $2, notional = notional - $3, margin = margin - $4 WHERE id = $1`,
			p.id, child.units, child.notional, child.margin); err != nil {
			return nil, err
		}
		return &child.id, closeIn(ctx, tx, key, child, price, reason, at)
	})
	if err != nil {
		return 0, err
	}
	return *id, nil
}

// Fill closes the position when the bar reaches its stop or target, at the price fill.Check returns.
func Fill(ctx context.Context, pool *pgxpool.Pool, key string, positionID int64, bar Bar) (bool, error) {
	if err := checkBar(bar); err != nil {
		return false, err
	}
	id, err := run(ctx, pool, "fill", key, &positionID, func(tx pgx.Tx, _ bool) (*int64, error) {
		p, err := load(ctx, tx, positionID)
		if err != nil {
			return nil, err
		}
		if p.closed {
			return nil, ErrClosed
		}
		price, reason := fill.Check(p.side == "long", p.stop, p.target, bar.Open, bar.High, bar.Low)
		if reason == "" {
			return nil, nil
		}
		return &p.id, closeIn(ctx, tx, key, p, price, reason, bar.Time)
	})
	return id != nil, err
}

func checkBar(bar Bar) error {
	if !positive(bar.Open) || !positive(bar.High) || !positive(bar.Low) || !(bar.Low <= bar.Open && bar.Open <= bar.High) || bar.Time.IsZero() {
		return invalid("bar needs open, high and low > 0, low <= open <= high and a time")
	}
	return nil
}

// Replay judges, oldest first, every stored candle of the position's instrument and granularity after its
// last judged bar, up to and including through. The caller sets through to the newest completed bar time,
// so a forming bar is never judged, and only once every bar up to through is stored: a bar stored later behind
// the last judged bar is never judged. The caller also replays through the newest completed bar before any
// ClosePartial on the position, so a replayed close is never dated before a booked partial close. Before the
// first replay, judging starts at the bar that contains the entry time, the next bar to complete after the
// entry (docs/fill-spec.md, entry bar). A bar that opened before the entry is judged with the entry price
// as its open: Open keeps the stop and target strictly beyond the entry after spread, so the gap rules cannot
// fire on it, and a fill on it is dated at the entry time. A bar that opens exactly at the entry time is
// judged with its own stored open, so a gap fill can fire on it. The first
// bar that reaches the stop or target closes the position at that bar's time and at the fill.Check price.
// The newest judged bar time is stored in the same transaction, so after a restart no bar is skipped or
// judged twice. A judged candle that fails the bar checks refuses the replay and writes nothing; bars after
// the fill bar are not judged. A repeated key returns its stored result, so the key must name both the
// position and through.
func Replay(ctx context.Context, pool *pgxpool.Pool, key string, positionID int64, through time.Time) (bool, error) {
	if through.IsZero() {
		return false, errNoTime
	}
	id, err := run(ctx, pool, "replay", key, &positionID, func(tx pgx.Tx, _ bool) (*int64, error) {
		p, err := load(ctx, tx, positionID)
		if err != nil {
			return nil, err
		}
		if p.closed {
			return nil, ErrClosed
		}
		if p.granularity == nil {
			return nil, invalid(fmt.Sprintf("position %d has no granularity to replay", p.id))
		}
		length, err := domain.GranularityDuration(*p.granularity)
		if err != nil {
			return nil, invalid(err.Error())
		}
		// A bar starting after entry_time - length still runs at the entry time, so it contains the entry.
		rows, err := tx.Query(ctx, `SELECT c.time, c.open, c.high, c.low FROM candles c JOIN ledger_positions p
			ON c.instrument = p.instrument AND c.granularity = p.granularity
			WHERE p.id = $1 AND c.time <= $2
			AND (c.time > p.last_judged_at OR (p.last_judged_at IS NULL AND c.time > p.entry_time - make_interval(secs => $3)))
			ORDER BY c.time`, p.id, through, length.Seconds())
		if err != nil {
			return nil, err
		}
		bars, err := pgx.CollectRows(rows, pgx.RowToStructByPos[Bar])
		if err != nil || len(bars) == 0 {
			return nil, err
		}
		var closed *int64
		judged := bars[len(bars)-1].Time
		for _, bar := range bars {
			if err := checkBar(bar); err != nil {
				return nil, fmt.Errorf("candle at %s: %w", bar.Time.Format(time.RFC3339), err)
			}
			open, at := bar.Open, bar.Time
			if bar.Time.Before(p.entryTime) {
				open, at = p.entry, p.entryTime
			}
			if price, reason := fill.Check(p.side == "long", p.stop, p.target, open, bar.High, bar.Low); reason != "" {
				if err := closeIn(ctx, tx, key, p, price, reason, at); err != nil {
					return nil, err
				}
				closed, judged = &p.id, bar.Time
				break
			}
		}
		_, err = tx.Exec(ctx, `UPDATE ledger_positions SET last_judged_at = $2 WHERE id = $1`, p.id, judged)
		return closed, err
	})
	return id != nil, err
}

// Mark sets the last mark of each open position whose instrument has a quote > 0. A position whose
// loss reaches its margin closes with reason "margin". Equity <= 0 halts the account. Stops and targets
// are judged by Fill and Replay.
func Mark(ctx context.Context, pool *pgxpool.Pool, key string, quotes map[string]float64, at time.Time) error {
	if at.IsZero() {
		return errNoTime
	}
	_, err := run(ctx, pool, "mark", key, nil, func(tx pgx.Tx, halted bool) (*int64, error) {
		open, err := openPositions(ctx, tx)
		if err != nil {
			return nil, err
		}
		for _, p := range open {
			q, ok := quotes[p.instrument]
			if !ok || !positive(q) {
				continue
			}
			if _, err := tx.Exec(ctx, `UPDATE ledger_positions SET last_mark = $2, last_mark_at = $3 WHERE id = $1`, p.id, q, at); err != nil {
				return nil, err
			}
			if unrealized(p.side, p.entry, p.units, q) <= -p.margin {
				if err := closeIn(ctx, tx, key, p, q, "margin", at); err != nil {
					return nil, err
				}
			}
		}
		var equity float64
		if err := tx.QueryRow(ctx, equitySQL).Scan(&equity); err != nil {
			return nil, err
		}
		if equity <= 0 && !halted {
			return nil, haltIn(ctx, tx, key, "equity <= 0", at)
		}
		return nil, journal(ctx, tx, at, "mark", nil, "", key, map[string]any{"equity": equity})
	})
	return err
}

// Halt is the kill switch: it closes every open position at its last mark and halts the account.
func Halt(ctx context.Context, pool *pgxpool.Pool, key, reason string, at time.Time) error {
	if at.IsZero() {
		return errNoTime
	}
	_, err := run(ctx, pool, "halt", key, nil, func(tx pgx.Tx, _ bool) (*int64, error) {
		return nil, haltIn(ctx, tx, key, reason, at)
	})
	return err
}

// ResetHalt lets the account open positions again.
func ResetHalt(ctx context.Context, pool *pgxpool.Pool, key string, at time.Time) error {
	if at.IsZero() {
		return errNoTime
	}
	_, err := run(ctx, pool, "reset", key, nil, func(tx pgx.Tx, _ bool) (*int64, error) {
		if _, err := tx.Exec(ctx, `UPDATE ledger_account SET halted = false WHERE id = 1`); err != nil {
			return nil, err
		}
		return nil, journal(ctx, tx, at, "reset", nil, "", key, nil)
	})
	return err
}

func haltIn(ctx context.Context, tx pgx.Tx, key, reason string, at time.Time) error {
	open, err := openPositions(ctx, tx)
	if err != nil {
		return err
	}
	for _, p := range open {
		if err := closeIn(ctx, tx, key, p, p.lastMark, "halt", at); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE ledger_account SET halted = true WHERE id = 1`); err != nil {
		return err
	}
	return journal(ctx, tx, at, "halt", nil, reason, key, nil)
}

// closeIn inserts the trade first, so the UNIQUE key on ledger_trades.position_id refuses a second close.
func closeIn(ctx context.Context, tx pgx.Tx, key string, p position, price float64, reason string, at time.Time) error {
	realized := unrealized(p.side, p.entry, p.units, price)
	_, err := tx.Exec(ctx, `INSERT INTO ledger_trades (position_id, instrument, side, notional, units, entry_price, entry_time,
		close_price, close_time, leverage, realized, close_reason, granularity)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
		p.id, p.instrument, p.side, p.notional, p.units, p.entry, p.entryTime, price, at, p.leverage, realized, reason, p.granularity)
	var pe *pgconn.PgError
	if errors.As(err, &pe) && pe.Code == "23505" {
		return fmt.Errorf("%w: %w", ErrClosed, err)
	} else if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE ledger_account SET cash = cash + $1 WHERE id = 1`, p.margin+realized); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE ledger_positions SET closed_at = $2 WHERE id = $1`, p.id, at); err != nil {
		return err
	}
	return journal(ctx, tx, at, "close", &p.id, reason, key, map[string]any{"price": price, "realized": realized})
}

// equitySQL is cash plus the margin and unrealized profit at the last mark of every open position.
const equitySQL = `SELECT a.cash + COALESCE(sum(p.margin + CASE WHEN p.side = 'long'
	THEN (p.last_mark - p.entry_price) ELSE (p.entry_price - p.last_mark) END * p.units), 0)
	FROM ledger_account a LEFT JOIN ledger_positions p ON p.closed_at IS NULL WHERE a.id = 1 GROUP BY a.cash`

const positionCols = `id, instrument, side, notional, units, entry_price, leverage, margin, stop, last_mark, target, entry_time, granularity, closed_at IS NOT NULL`

func scanPosition(row pgx.Row) (position, error) {
	var p position
	err := row.Scan(&p.id, &p.instrument, &p.side, &p.notional, &p.units, &p.entry, &p.leverage, &p.margin, &p.stop,
		&p.lastMark, &p.target, &p.entryTime, &p.granularity, &p.closed)
	return p, err
}

func load(ctx context.Context, tx pgx.Tx, id int64) (position, error) {
	p, err := scanPosition(tx.QueryRow(ctx, `SELECT `+positionCols+` FROM ledger_positions WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return p, invalid(fmt.Sprintf("unknown position %d", id))
	}
	return p, err
}

func openPositions(ctx context.Context, tx pgx.Tx) ([]position, error) {
	rows, err := tx.Query(ctx, `SELECT `+positionCols+` FROM ledger_positions WHERE closed_at IS NULL ORDER BY id`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (position, error) { return scanPosition(r) })
}

func journal(ctx context.Context, tx pgx.Tx, at time.Time, action string, positionID *int64, reason, key string, detail map[string]any) error {
	_, err := tx.Exec(ctx, `INSERT INTO ledger_journal (at, action, position_id, reason, context, idempotency_key)
		VALUES ($1, $2, $3, NULLIF($4, ''), $5, NULLIF($6, ''))`, at, action, positionID, reason, detail, key)
	return err
}
