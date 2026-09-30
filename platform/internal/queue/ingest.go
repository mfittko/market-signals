package queue

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// IngestInput is one immutable decision-point snapshot to fan out to agents.
type IngestInput struct {
	IdemKey     string
	Instrument  string
	Granularity string
	Event       string
	Source      string // engine | operator | demo
	Trigger     string // free-form: flip, impulse, review, operator, demo
	Payload     json.RawMessage
	AgentID     string // optional: restrict to one agent
}

type RunRef struct {
	RunID   int64  `json:"runId"`
	AgentID string `json:"agentId"`
	Created bool   `json:"created"`
}

type IngestResult struct {
	SnapshotID int64    `json:"snapshotId"`
	NewSnap    bool     `json:"newSnapshot"`
	Runs       []RunRef `json:"runs"`
}

func digest(payload json.RawMessage) string {
	var v any
	if json.Unmarshal(payload, &v) == nil {
		if b, err := json.Marshal(v); err == nil { // map keys are sorted: canonical
			payload = b
		}
	}
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

func (s *Store) emit(ctx context.Context, tx pgx.Tx, runID int64, attemptID *int64, kind string, payload any) error {
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO run_events (run_id, attempt_id, kind, payload) VALUES ($1,$2,$3,$4)`, runID, attemptID, kind, b)
	return err
}

// Ingest stores the snapshot and enqueues one run per matching enabled agent (or the one agent an operator names) in
// a single transaction, so an accepted event can never exist without its runs.
// The same idempotency key returns the original snapshot and runs.
func (s *Store) Ingest(ctx context.Context, in IngestInput) (IngestResult, error) {
	var res IngestResult
	if in.IdemKey == "" || in.Instrument == "" || in.Granularity == "" || len(in.Payload) == 0 {
		return res, errors.New("idemKey, instrument, granularity and payload are required")
	}
	if len(in.Payload) > MaxSnapshotBytes {
		return res, fmt.Errorf("%w: %d bytes, the limit is %d", ErrSnapshotTooLarge, len(in.Payload), MaxSnapshotBytes)
	}
	if in.Trigger == "" {
		in.Trigger = in.Event
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return res, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	err = tx.QueryRow(ctx, `INSERT INTO snapshots (idem_key,instrument,granularity,event,source,payload,digest)
		VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (idem_key) DO NOTHING RETURNING id`,
		in.IdemKey, in.Instrument, in.Granularity, in.Event, in.Source, []byte(in.Payload), digest(in.Payload)).Scan(&res.SnapshotID)
	switch {
	case err == nil:
		res.NewSnap = true
	case errors.Is(err, pgx.ErrNoRows):
		if err := tx.QueryRow(ctx, `SELECT id FROM snapshots WHERE idem_key=$1`, in.IdemKey).Scan(&res.SnapshotID); err != nil {
			return res, err
		}
	default:
		return res, err
	}

	rows, err := tx.Query(ctx, `SELECT a.id, a.budgets, s.id FROM agents a JOIN sessions s ON s.agent_id=a.id
		WHERE (a.enabled OR $3<>'') AND a.instrument=$1 AND a.granularity=$2 AND ($3='' OR a.id=$3) ORDER BY a.id`,
		in.Instrument, in.Granularity, in.AgentID)
	if err != nil {
		return res, err
	}
	type target struct {
		agent   string
		budgets Budgets
		session int64
	}
	var targets []target
	for rows.Next() {
		var t target
		var b []byte
		if err := rows.Scan(&t.agent, &b, &t.session); err != nil {
			rows.Close()
			return res, err
		}
		_ = json.Unmarshal(b, &t.budgets)
		t.budgets = t.budgets.WithDefaults()
		targets = append(targets, t)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return res, err
	}
	for _, t := range targets {
		var runID int64
		err := tx.QueryRow(ctx, `INSERT INTO runs (agent_id,session_id,snapshot_id,trigger,max_attempts)
			VALUES ($1,$2,$3,$4,$5) ON CONFLICT (agent_id,snapshot_id) DO NOTHING RETURNING id`,
			t.agent, t.session, res.SnapshotID, in.Trigger, t.budgets.MaxAttempts).Scan(&runID)
		ref := RunRef{AgentID: t.agent}
		switch {
		case err == nil:
			ref.Created, ref.RunID = true, runID
			if err := s.emit(ctx, tx, runID, nil, "queued", map[string]any{"trigger": in.Trigger, "snapshotId": res.SnapshotID, "source": in.Source}); err != nil {
				return res, err
			}
		case errors.Is(err, pgx.ErrNoRows):
			if err := tx.QueryRow(ctx, `SELECT id FROM runs WHERE agent_id=$1 AND snapshot_id=$2`, t.agent, res.SnapshotID).Scan(&ref.RunID); err != nil {
				return res, err
			}
		default:
			return res, err
		}
		res.Runs = append(res.Runs, ref)
	}
	if err := tx.Commit(ctx); err != nil {
		return res, err
	}
	return res, nil
}

// SetLegacy records the engine's own decision for a snapshot and refreshes the
// shadow comparison on every run of that snapshot.
func (s *Store) SetLegacy(ctx context.Context, idemKey string, legacy json.RawMessage) (int, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var snapID int64
	if err := tx.QueryRow(ctx, `SELECT id FROM snapshots WHERE idem_key=$1`, idemKey).Scan(&snapID); err != nil {
		return 0, ErrNotFound
	}
	rows, err := tx.Query(ctx, `UPDATE runs SET legacy_decision=$2, updated_at=now() WHERE snapshot_id=$1 RETURNING id`, snapID, []byte(legacy))
	if err != nil {
		return 0, err
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	for _, id := range ids {
		if err := s.recompute(ctx, tx, id); err != nil {
			return 0, err
		}
		if err := s.emit(ctx, tx, id, nil, "legacy_decision", json.RawMessage(legacy)); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return len(ids), nil
}

// recompute derives comparison from proposal and legacy decision.
func (s *Store) recompute(ctx context.Context, tx pgx.Tx, runID int64) error {
	var proposal, validation, legacy []byte
	var source string
	if err := tx.QueryRow(ctx, `SELECT r.proposal, r.validation, r.legacy_decision, sn.source FROM runs r JOIN snapshots sn ON sn.id=r.snapshot_id WHERE r.id=$1`, runID).Scan(&proposal, &validation, &legacy, &source); err != nil {
		return err
	}
	cmp := "pending"
	switch {
	case proposal != nil && legacy != nil:
		cmp = compareJSON(proposal, validation, legacy)
	case proposal != nil && source != "engine":
		cmp = "no_legacy"
	}
	_, err := tx.Exec(ctx, `UPDATE runs SET comparison=$2 WHERE id=$1`, runID, cmp)
	return err
}

// compareJSON compares the effective outcome with the engine's decision. A
// rejected proposal never stands, so its effective outcome is a hold.
func compareJSON(proposal, validation, legacy []byte) string {
	var p struct {
		Action string `json:"action"`
		Side   string `json:"side"`
	}
	var v struct {
		Valid *bool `json:"valid"`
	}
	var l struct {
		Decision struct {
			Action string `json:"action"`
			Side   string `json:"side"`
		} `json:"decision"`
		Action string `json:"action"`
		Side   string `json:"side"`
	}
	if json.Unmarshal(proposal, &p) != nil || json.Unmarshal(legacy, &l) != nil {
		return "pending"
	}
	if validation != nil && json.Unmarshal(validation, &v) == nil && v.Valid != nil && !*v.Valid {
		p.Action, p.Side = "hold", ""
	}
	la, ls := l.Decision.Action, l.Decision.Side
	if la == "" { // bare decision object
		la, ls = l.Action, l.Side
	}
	if p.Action != la || (la == "open" && p.Side != ls) {
		return "differ"
	}
	return "agree"
}

var _ = fmt.Sprintf
