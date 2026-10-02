package queue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/mfittko/market-signals/platform/internal/domain"
)

// Position is a shadow position: the virtual result of an accepted entry.
// The monitor advances its state; a woken agent may only tighten or close it.
type Position struct {
	ID             int64          `json:"id"`
	AgentID        string         `json:"agentId"`
	RunID          int64          `json:"runId"`
	Instrument     string         `json:"instrument"`
	Granularity    string         `json:"granularity"`
	Side           string         `json:"side"`
	Notional       float64        `json:"notional"`
	EntryPrice     float64        `json:"entryPrice"`
	EntryTime      time.Time      `json:"entryTime"`
	InitialStop    float64        `json:"initialStop"`
	Stop           float64        `json:"stop"`
	Target         *float64       `json:"target,omitempty"`
	Plan           domain.Plan    `json:"plan"`
	BarsHeld       int            `json:"barsHeld"`
	Best           float64        `json:"best"`
	LastClose      float64        `json:"lastClose"`
	LastBarTime    *time.Time     `json:"lastBarTime,omitempty"`
	LastFired      map[string]int `json:"lastFired"`
	Status         string         `json:"status"`
	ExitPrice      *float64       `json:"exitPrice,omitempty"`
	ExitTime       *time.Time     `json:"exitTime,omitempty"`
	ExitReason     string         `json:"exitReason,omitempty"`
	Realized       *float64       `json:"realized,omitempty"`
	Wakes          int            `json:"wakes"`
	FailedWakes    int            `json:"failedWakes"`
	NeedsAttention bool           `json:"needsAttention"`
}

type PositionEvent struct {
	ID      int64           `json:"id"`
	At      time.Time       `json:"at"`
	Kind    string          `json:"kind"`
	Payload json.RawMessage `json:"payload"`
}

const positionCols = `id, agent_id, run_id, instrument, granularity, side, notional, entry_price, entry_time, initial_stop, stop, target, plan,
  bars_held, COALESCE(best,0), COALESCE(last_close,0), last_bar_time, last_fired, status, exit_price, exit_time, COALESCE(exit_reason,''), realized,
  wakes, failed_wakes, needs_attention`

func scanPosition(r scanner) (Position, error) {
	var p Position
	var plan, fired []byte
	err := r.Scan(&p.ID, &p.AgentID, &p.RunID, &p.Instrument, &p.Granularity, &p.Side, &p.Notional, &p.EntryPrice, &p.EntryTime, &p.InitialStop, &p.Stop, &p.Target, &plan,
		&p.BarsHeld, &p.Best, &p.LastClose, &p.LastBarTime, &fired, &p.Status, &p.ExitPrice, &p.ExitTime, &p.ExitReason, &p.Realized, &p.Wakes, &p.FailedWakes, &p.NeedsAttention)
	if err != nil {
		return p, err
	}
	_ = json.Unmarshal(plan, &p.Plan)
	p.LastFired = map[string]int{}
	_ = json.Unmarshal(fired, &p.LastFired)
	return p, nil
}

func (s *Store) ListPositions(ctx context.Context, status string, limit int) ([]Position, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.Pool.Query(ctx, `SELECT `+positionCols+` FROM shadow_positions WHERE ($1='' OR status=$1) ORDER BY (status='open') DESC, COALESCE(exit_time, entry_time) DESC, id DESC LIMIT $2`, status, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Position{}
	for rows.Next() {
		p, err := scanPosition(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Store) GetPosition(ctx context.Context, id int64) (*Position, []PositionEvent, error) {
	p, err := scanPosition(s.Pool.QueryRow(ctx, `SELECT `+positionCols+` FROM shadow_positions WHERE id=$1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, ErrNotFound
	}
	if err != nil {
		return nil, nil, err
	}
	rows, err := s.Pool.Query(ctx, `SELECT id, at, kind, payload FROM position_events WHERE position_id=$1 ORDER BY id`, id)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	ev := []PositionEvent{}
	for rows.Next() {
		var e PositionEvent
		if err := rows.Scan(&e.ID, &e.At, &e.Kind, &e.Payload); err != nil {
			return nil, nil, err
		}
		ev = append(ev, e)
	}
	return &p, ev, rows.Err()
}

// SavePosition stores the monitor's state after a bar and returns the stop now on record.
// It touches only an open position. A wake may have tightened the stop or replaced the
// tripwires while the monitor waited on the feed, so the write can only move the stop
// closer to price, never writes the plan, and merges the cooldown marks instead of
// replacing them. The caller adopts the returned stop. A closed position returns 0.
func (s *Store) SavePosition(ctx context.Context, p Position) (float64, error) {
	fired, _ := json.Marshal(p.LastFired)
	var stop float64
	err := s.Pool.QueryRow(ctx, `UPDATE shadow_positions SET
		  stop = CASE WHEN side='long' THEN GREATEST(stop,$2) ELSE LEAST(stop,$2) END,
		  bars_held=$3, best=$4, last_close=$5, last_bar_time=$6, last_fired = last_fired || $7::jsonb
		WHERE id=$1 AND status='open' RETURNING stop`, p.ID, p.Stop, p.BarsHeld, p.Best, p.LastClose, p.LastBarTime, fired).Scan(&stop)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	return stop, err
}

// ClosePosition ends an open position. It reports whether this call closed it, so a
// close racing a wake resolves once.
func (s *Store) ClosePosition(ctx context.Context, id int64, price float64, at time.Time, reason string) (bool, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	ok, err := closePositionTx(ctx, tx, id, price, at, reason)
	if err != nil || !ok {
		return false, err
	}
	return true, tx.Commit(ctx)
}

func closePositionTx(ctx context.Context, tx pgx.Tx, id int64, price float64, at time.Time, reason string) (bool, error) {
	var side string
	var notional, entry float64
	err := tx.QueryRow(ctx, `SELECT side, notional, entry_price FROM shadow_positions WHERE id=$1 AND status='open' FOR UPDATE`, id).Scan(&side, &notional, &entry)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	realized := domain.PnL(side, notional, entry, price)
	if _, err := tx.Exec(ctx, `UPDATE shadow_positions SET status='closed', exit_price=$2, exit_time=$3, exit_reason=$4, realized=$5 WHERE id=$1`, id, price, at, reason, realized); err != nil {
		return false, err
	}
	return true, addPositionEvent(ctx, tx, id, "exit", map[string]any{"price": price, "reason": reason, "realized": realized})
}

func addPositionEvent(ctx context.Context, tx pgx.Tx, id int64, kind string, payload any) error {
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO position_events (position_id, kind, payload) VALUES ($1,$2,$3)`, id, kind, b)
	return err
}

func (s *Store) AddPositionEvent(ctx context.Context, id int64, kind string, payload any) error {
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = s.Pool.Exec(ctx, `INSERT INTO position_events (position_id, kind, payload) VALUES ($1,$2,$3)`, id, kind, b)
	return err
}

// RaiseAttention records the event and asks the operator to look at the position.
func (s *Store) RaiseAttention(ctx context.Context, id int64, kind string, payload any) error {
	return pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE shadow_positions SET needs_attention=true WHERE id=$1`, id); err != nil {
			return err
		}
		return addPositionEvent(ctx, tx, id, kind, payload)
	})
}

// openPositionTx records the shadow position for an accepted entry. A second open
// for the same agent, or a repeat for the same run, is ignored by the unique indexes.
// An ignored open from another run leaves an open_ignored event on the position the
// agent already holds, so the audit trail explains the missing position.
func openPositionTx(ctx context.Context, tx pgx.Tx, runID int64, a Agent, d domain.Decision, price float64, at time.Time) error {
	plan := domain.Plan{}
	if d.Plan != nil {
		plan = *d.Plan
	}
	pb, _ := json.Marshal(plan)
	var id int64
	err := tx.QueryRow(ctx, `INSERT INTO shadow_positions (agent_id, run_id, instrument, granularity, side, notional, entry_price, entry_time, initial_stop, stop, target, plan, best)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$7) ON CONFLICT DO NOTHING RETURNING id`,
		a.ID, runID, a.Instrument, a.Granularity, d.Side, d.Notional, price, at, d.Stop, d.Target, pb).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		var held, heldRun int64
		err := tx.QueryRow(ctx, `SELECT id, run_id FROM shadow_positions WHERE agent_id=$1 AND status='open'`, a.ID).Scan(&held, &heldRun)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && heldRun == runID) {
			return nil // this run already opened its position
		}
		if err != nil {
			return err
		}
		return addPositionEvent(ctx, tx, held, "open_ignored", map[string]any{"runId": runID, "side": d.Side, "price": price,
			"why": fmt.Sprintf("the agent already holds position %d", held)})
	}
	if err != nil {
		return err
	}
	return addPositionEvent(ctx, tx, id, "opened", map[string]any{"runId": runID, "side": d.Side, "price": price, "stop": d.Stop, "target": d.Target, "plan": plan, "reasoning": d.Reasoning})
}

// applyWakeTx applies the result of a tripwire wake. The proposal was already
// validated by ValidateWake. Each change is guarded again in SQL because the
// monitor may have moved the stop or closed the position since the snapshot.
func applyWakeTx(ctx context.Context, tx pgx.Tx, runID int64, w domain.WakePosition, d domain.Decision, price float64, at time.Time) error {
	note := func(kind string, m map[string]any) error {
		m["runId"], m["tripwire"] = runID, w.Alert
		return addPositionEvent(ctx, tx, w.ID, kind, m)
	}
	if _, err := tx.Exec(ctx, `UPDATE shadow_positions SET failed_wakes=0 WHERE id=$1`, w.ID); err != nil {
		return err
	}
	switch d.Action {
	case "close":
		// The snapshot can be minutes old by the time the model answers. The monitor keeps the last
		// completed bar's close up to date, so prefer it when it is fresh: a stale fill must not beat the market.
		var last float64
		var lastAt *time.Time
		if err := tx.QueryRow(ctx, `SELECT COALESCE(last_close,0), last_bar_time FROM shadow_positions WHERE id=$1`, w.ID).Scan(&last, &lastAt); err != nil {
			return err
		}
		if last > 0 && lastAt != nil && at.Sub(*lastAt) < 3*time.Minute {
			price = last
		}
		ok, err := closePositionTx(ctx, tx, w.ID, price, at, "agent_close")
		if err != nil {
			return err
		}
		if !ok {
			return note("wake_ignored", map[string]any{"action": "close", "why": "the position was already closed"})
		}
	case "tighten_stop":
		tag, err := tx.Exec(ctx, `UPDATE shadow_positions SET stop=$2 WHERE id=$1 AND status='open'
			AND ((side='long' AND $2 > stop AND $2 < $3) OR (side='short' AND $2 < stop AND $2 > $3))`, w.ID, *d.NewStop, price)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return note("wake_ignored", map[string]any{"action": "tighten_stop", "newStop": *d.NewStop, "why": "the stop already sits closer, or the position is closed"})
		}
		return note("tighten", map[string]any{"newStop": *d.NewStop, "reasoning": d.Reasoning})
	case "set_tripwires":
		tb, _ := json.Marshal(d.Tripwires)
		tag, err := tx.Exec(ctx, `UPDATE shadow_positions SET plan=jsonb_set(plan,'{tripwires}',$2::jsonb), last_fired='{}'::jsonb WHERE id=$1 AND status='open'`, w.ID, tb)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return note("wake_ignored", map[string]any{"action": "set_tripwires", "why": "the position is closed"})
		}
		return note("tripwires", map[string]any{"tripwires": d.Tripwires, "reasoning": d.Reasoning})
	default: // hold
		return note("wake_hold", map[string]any{"reasoning": d.Reasoning})
	}
	return nil
}

// WakeState is what the monitor needs before it wakes an agent again.
type WakeState struct {
	InFlight   bool // a wake run for this position has not finished
	Last24h    int  // wakes recorded in the last 24 hours
	FailedRuns int  // consecutive failed wakes (reset by any completed wake)
}

func (s *Store) WakeState(ctx context.Context, id int64, now time.Time) (WakeState, error) {
	var w WakeState
	err := s.Pool.QueryRow(ctx, `SELECT
		EXISTS (SELECT 1 FROM position_events e JOIN runs r ON r.id=(e.payload->>'runId')::bigint
		        WHERE e.position_id=$1 AND e.kind='wake' AND r.status IN ('queued','running','waiting_for_event')),
		(SELECT count(*) FROM position_events WHERE position_id=$1 AND kind='wake' AND at > $2::timestamptz - interval '24 hours'),
		(SELECT failed_wakes FROM shadow_positions WHERE id=$1)`, id, now).Scan(&w.InFlight, &w.Last24h, &w.FailedRuns)
	return w, err
}

// RecordWake notes that a wake run was enqueued for a position.
func (s *Store) RecordWake(ctx context.Context, id, runID int64, payload map[string]any) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var noted bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM position_events WHERE position_id=$1 AND kind='wake' AND (payload->>'runId')::bigint=$2)`, id, runID).Scan(&noted); err != nil {
		return err
	}
	if noted {
		return nil
	}
	payload["runId"] = runID
	if _, err := tx.Exec(ctx, `UPDATE shadow_positions SET wakes=wakes+1 WHERE id=$1`, id); err != nil {
		return err
	}
	if err := addPositionEvent(ctx, tx, id, "wake", payload); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// MaxFailedWakes is how many wakes in a row may fail before the operator is asked to look.
const MaxFailedWakes = 3

// ReconcileFailedWakes counts wake runs that ended without an answer (failed, expired or
// cancelled) exactly once each. The stop stays in force meanwhile. Enough failures in a row
// raise the attention flag. It reports the number of newly counted failures.
func (s *Store) ReconcileFailedWakes(ctx context.Context, id int64) (int, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	rows, err := tx.Query(ctx, `SELECT e.id, r.status FROM position_events e JOIN runs r ON r.id=(e.payload->>'runId')::bigint
		WHERE e.position_id=$1 AND e.kind='wake' AND r.status IN ('failed','expired','cancelled')
		  AND NOT EXISTS (SELECT 1 FROM position_events f WHERE f.position_id=$1 AND f.kind='wake_failed' AND f.payload->>'wakeEvent'=e.id::text)
		ORDER BY e.id`, id)
	if err != nil {
		return 0, err
	}
	type miss struct {
		event  int64
		status string
	}
	var misses []miss
	for rows.Next() {
		var m miss
		if err := rows.Scan(&m.event, &m.status); err != nil {
			rows.Close()
			return 0, err
		}
		misses = append(misses, m)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	for _, m := range misses {
		if err := addPositionEvent(ctx, tx, id, "wake_failed", map[string]any{"wakeEvent": fmt.Sprint(m.event), "status": m.status, "note": "no answer; the stop stays in force"}); err != nil {
			return 0, err
		}
		var failed int
		if err := tx.QueryRow(ctx, `UPDATE shadow_positions SET failed_wakes=failed_wakes+1 WHERE id=$1 RETURNING failed_wakes`, id).Scan(&failed); err != nil {
			return 0, err
		}
		if failed >= MaxFailedWakes {
			if _, err := tx.Exec(ctx, `UPDATE shadow_positions SET needs_attention=true WHERE id=$1`, id); err != nil {
				return 0, err
			}
			if err := addPositionEvent(ctx, tx, id, "attention", map[string]any{"why": fmt.Sprintf("%d wakes in a row got no answer", failed)}); err != nil {
				return 0, err
			}
		}
	}
	return len(misses), tx.Commit(ctx)
}
