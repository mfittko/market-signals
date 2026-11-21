package ledger

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mfittko/market-signals/platform/internal/legacy"
)

// Totals is one side of the reconciliation.
type Totals struct {
	Cash          float64 `json:"cash"`
	Equity        float64 `json:"equity"`
	OpenPositions int     `json:"openPositions"`
}

// ImportReport compares the Node paper book with the Go ledger after the import's writes.
type ImportReport struct {
	Committed       bool     `json:"committed"`
	AccountCreated  bool     `json:"accountCreated"`
	Node            Totals   `json:"node"`
	Go              Totals   `json:"go"`
	Booked          int      `json:"booked"`
	AlreadyImported int      `json:"alreadyImported"`
	Refused         int      `json:"refused"`
	Differences     []string `json:"differences"`
}

// OK reports whether the Go ledger matches the Node book.
func (r *ImportReport) OK() bool { return len(r.Differences) == 0 }

func (r *ImportReport) differ(format string, a ...any) {
	r.Differences = append(r.Differences, fmt.Sprintf(format, a...))
}

// nodePosition is one row of the Node positions table. Node deletes a row when its position closes.
type nodePosition struct {
	id                                                 int64
	instrument, side, entryTime                        string
	notional, units, entry, leverage, margin, lastMark float64
	stop, target                                       sql.NullFloat64
	lastMarkAt, granularity                            sql.NullString
	entryAt, markAt                                    time.Time
}

func (n nodePosition) name() string {
	return fmt.Sprintf("node position %d %s %s", n.id, n.instrument, n.side)
}

// refusal returns why the Go ledger cannot hold n, or "" when it can. It parses the times into n.
func (n *nodePosition) refusal() string {
	var err error
	switch {
	case n.side != "long" && n.side != "short":
		return "side must be long|short"
	case n.instrument == "":
		return "instrument required"
	case !positive(n.notional) || !positive(n.units) || !positive(n.entry) || !positive(n.leverage) ||
		!positive(n.margin) || !positive(n.lastMark):
		return "notional, units, entry price, leverage, margin and last mark must be > 0"
	case !n.stop.Valid:
		return "no stop; the Go ledger requires one"
	case !positive(n.stop.Float64) || (n.target.Valid && !positive(n.target.Float64)):
		return "stop must be > 0, and target when set"
	case n.side == "long" && !(n.stop.Float64 < n.entry), n.side == "short" && !(n.stop.Float64 > n.entry):
		return "stop is not on the loss side of the entry price"
	// The entry price already includes the spread, so this is the Go Open rule.
	case n.target.Valid && (n.side == "long" && !(n.target.Float64 > n.entry) || n.side == "short" && !(n.target.Float64 < n.entry)):
		return "target does not lie beyond the entry price"
	}
	if n.entryAt, err = legacy.ParseTime(n.entryTime); err != nil {
		return "entry time: " + err.Error()
	}
	n.markAt = n.entryAt
	if n.lastMarkAt.Valid {
		if n.markAt, err = legacy.ParseTime(n.lastMarkAt.String); err != nil {
			return "last mark time: " + err.Error()
		}
	}
	return ""
}

func (n nodePosition) key() string {
	return fmt.Sprintf("node-import:position:%d:%s", n.id, n.entryTime)
}

type nodeAccount struct {
	startingBalance, cash float64
	halted                bool
	createdAt             time.Time
}

func readNodeBook(path string) (nodeAccount, []nodePosition, error) {
	var a nodeAccount
	src, cleanup, err := legacy.OpenCopy(path)
	if err != nil {
		return a, nil, err
	}
	defer cleanup()
	var created string
	if err := src.QueryRow(`SELECT starting_balance, cash, halted, created_at FROM portfolio WHERE id = 1`).
		Scan(&a.startingBalance, &a.cash, &a.halted, &created); err != nil {
		return a, nil, fmt.Errorf("node portfolio: %w", err)
	}
	if a.createdAt, err = legacy.ParseTime(created); err != nil {
		return a, nil, fmt.Errorf("node portfolio created_at: %w", err)
	}
	if !positive(a.startingBalance) || math.IsNaN(a.cash) || math.IsInf(a.cash, 0) {
		return a, nil, invalid("node portfolio needs a starting balance > 0 and a finite cash")
	}
	rows, err := src.Query(`SELECT id, instrument, side, notional, units, entry_price, entry_time, leverage, margin,
		stop, target, last_mark, last_mark_at, granularity FROM positions ORDER BY id`)
	if err != nil {
		return a, nil, fmt.Errorf("node positions: %w", err)
	}
	defer rows.Close()
	var out []nodePosition
	for rows.Next() {
		var n nodePosition
		if err := rows.Scan(&n.id, &n.instrument, &n.side, &n.notional, &n.units, &n.entry, &n.entryTime, &n.leverage,
			&n.margin, &n.stop, &n.target, &n.lastMark, &n.lastMarkAt, &n.granularity); err != nil {
			return a, nil, fmt.Errorf("node positions: %w", err)
		}
		out = append(out, n)
	}
	return a, out, rows.Err()
}

// ImportNode copies the Node paper book at path (a SQLite file, read through a private copy) into the
// ledger in one transaction and reconciles cash, equity and open positions. It commits only when commit
// is set; a dry run computes the same report and rolls back. An existing account is left unchanged. A
// position the Go ledger cannot hold is refused and listed, never adjusted. Each position is booked once
// under the key node-import:position:<node id>:<entry time>, so a repeated import books nothing new.
func ImportNode(ctx context.Context, pool *pgxpool.Pool, path string, commit bool, at time.Time) (*ImportReport, error) {
	if at.IsZero() {
		return nil, errNoTime
	}
	acct, nodes, err := readNodeBook(path)
	if err != nil {
		return nil, err
	}
	rep := &ImportReport{Node: Totals{Cash: acct.cash, Equity: acct.cash, OpenPositions: len(nodes)}, Differences: []string{}}
	for _, n := range nodes {
		rep.Node.Equity += n.margin + unrealized(n.side, n.entry, n.units, n.lastMark)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	tag, err := tx.Exec(ctx, `INSERT INTO ledger_account (id, starting_balance, cash, halted, created_at) VALUES (1, $1, $2, $3, $4)
		ON CONFLICT DO NOTHING`, acct.startingBalance, acct.cash, acct.halted, acct.createdAt)
	if err != nil {
		return nil, err
	}
	if rep.AccountCreated = tag.RowsAffected() == 1; rep.AccountCreated {
		if err := journal(ctx, tx, at, "import", nil, "", "", map[string]any{
			"source": "node", "startingBalance": acct.startingBalance, "cash": acct.cash}); err != nil {
			return nil, err
		}
	}
	// The account row lock serializes the import with every keyed operation.
	if _, err := tx.Exec(ctx, `SELECT 1 FROM ledger_account WHERE id = 1 FOR UPDATE`); err != nil {
		return nil, err
	}

	mapped := map[int64]bool{}
	for i := range nodes {
		n := &nodes[i]
		if reason := n.refusal(); reason != "" {
			rep.Refused++
			rep.differ("%s refused: %s", n.name(), reason)
			continue
		}
		id, booked, err := importPosition(ctx, tx, *n, at)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", n.name(), err)
		}
		if booked {
			rep.Booked++
		} else {
			rep.AlreadyImported++
		}
		if err := reconcilePosition(ctx, tx, rep, *n, id); err != nil {
			return nil, err
		}
		if id != nil {
			mapped[*id] = true
		}
	}

	open, err := openPositions(ctx, tx)
	if err != nil {
		return nil, err
	}
	for _, p := range open {
		if !mapped[p.id] {
			rep.differ("go position %d %s %s is open and not in the node book", p.id, p.instrument, p.side)
		}
	}
	rep.Go.OpenPositions = len(open)
	if err := tx.QueryRow(ctx, `SELECT cash FROM ledger_account WHERE id = 1`).Scan(&rep.Go.Cash); err != nil {
		return nil, err
	}
	if err := tx.QueryRow(ctx, equitySQL).Scan(&rep.Go.Equity); err != nil {
		return nil, err
	}
	// Sums in another order can differ in the last bits.
	const eps = 1e-6
	if math.Abs(rep.Go.Cash-rep.Node.Cash) > eps {
		rep.differ("cash: node %v, go %v", rep.Node.Cash, rep.Go.Cash)
	}
	if math.Abs(rep.Go.Equity-rep.Node.Equity) > eps {
		rep.differ("equity: node %v, go %v", rep.Node.Equity, rep.Go.Equity)
	}
	if rep.Go.OpenPositions != rep.Node.OpenPositions {
		rep.differ("open positions: node %d, go %d", rep.Node.OpenPositions, rep.Go.OpenPositions)
	}

	if commit {
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		rep.Committed = true
	}
	return rep, nil
}

// importPosition books n once under its key and returns the Go position id; a known key books nothing.
func importPosition(ctx context.Context, tx pgx.Tx, n nodePosition, at time.Time) (*int64, bool, error) {
	key := n.key()
	err := tx.QueryRow(ctx, `INSERT INTO ledger_requests (idempotency_key, op) VALUES ($1, 'import')
		ON CONFLICT DO NOTHING RETURNING true`, key).Scan(new(bool))
	if errors.Is(err, pgx.ErrNoRows) {
		var op string
		var id *int64
		if err := tx.QueryRow(ctx, `SELECT op, position_id FROM ledger_requests WHERE idempotency_key = $1`, key).Scan(&op, &id); err != nil {
			return nil, false, err
		}
		if op != "import" {
			return nil, false, invalid(fmt.Sprintf("idempotency key %q was used for %s", key, op))
		}
		return id, false, nil
	} else if err != nil {
		return nil, false, err
	}
	var target *float64
	if n.target.Valid {
		target = &n.target.Float64
	}
	var granularity *string
	if n.granularity.Valid {
		granularity = &n.granularity.String
	}
	var id int64
	if err := tx.QueryRow(ctx, `INSERT INTO ledger_positions (instrument, side, notional, units, entry_price, entry_time,
		leverage, margin, stop, target, last_mark, last_mark_at, granularity)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
		n.instrument, n.side, n.notional, n.units, n.entry, n.entryAt, n.leverage, n.margin, n.stop.Float64, target,
		n.lastMark, n.markAt, granularity).Scan(&id); err != nil {
		return nil, false, err
	}
	if _, err := tx.Exec(ctx, `UPDATE ledger_requests SET position_id = $2 WHERE idempotency_key = $1`, key, id); err != nil {
		return nil, false, err
	}
	return &id, true, journal(ctx, tx, at, "import", &id, "", key, map[string]any{"source": "node", "nodeId": n.id})
}

// reconcilePosition lists each field where the Go position differs from n, or the Go position is gone.
func reconcilePosition(ctx context.Context, tx pgx.Tx, rep *ImportReport, n nodePosition, id *int64) error {
	if id == nil {
		rep.differ("%s is missing from go", n.name())
		return nil
	}
	p, err := load(ctx, tx, *id)
	if err != nil {
		return err
	}
	if p.closed {
		rep.differ("%s is missing from go: go position %d is closed", n.name(), p.id)
		return nil
	}
	opt := func(valid bool, v any) any {
		if !valid {
			return nil
		}
		return v
	}
	for _, f := range []struct {
		field         string
		node, goValue any
	}{
		{"instrument", n.instrument, p.instrument},
		{"side", n.side, p.side},
		{"notional", n.notional, p.notional},
		{"units", n.units, p.units},
		{"entry_price", n.entry, p.entry},
		{"entry_time", n.entryAt.UTC().Format(time.RFC3339Nano), p.entryTime.UTC().Format(time.RFC3339Nano)},
		{"leverage", n.leverage, p.leverage},
		{"margin", n.margin, p.margin},
		{"stop", n.stop.Float64, p.stop},
		{"target", opt(n.target.Valid, n.target.Float64), opt(p.target != nil, deref(p.target))},
		{"last_mark", n.lastMark, p.lastMark},
		{"granularity", opt(n.granularity.Valid, n.granularity.String), opt(p.granularity != nil, deref(p.granularity))},
	} {
		if f.node != f.goValue {
			rep.differ("%s: go position %d %s: node %v, go %v", n.name(), p.id, f.field, f.node, f.goValue)
		}
	}
	return nil
}

func deref[T any](p *T) (v T) {
	if p != nil {
		v = *p
	}
	return v
}
