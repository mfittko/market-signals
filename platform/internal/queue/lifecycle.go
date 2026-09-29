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

// RegisterWorker records a worker and its reported runtime capabilities.
func (s *Store) RegisterWorker(ctx context.Context, id string, runtimes []string, caps json.RawMessage) error {
	if len(caps) == 0 {
		caps = json.RawMessage(`{}`)
	}
	_, err := s.Pool.Exec(ctx, `INSERT INTO workers (id,runtimes,capabilities,last_seen) VALUES ($1,$2,$3,now())
		ON CONFLICT (id) DO UPDATE SET runtimes=$2, capabilities=$3, last_seen=now()`, id, runtimes, []byte(caps))
	return err
}

const runCols = `r.id,r.agent_id,r.snapshot_id,r.trigger,r.status,r.attempts_made,r.max_attempts,r.followups_used,r.cancel_requested,
	COALESCE(r.wait_reason,''),r.wait_until,COALESCE(r.stop_reason,''),r.proposal,r.validation,r.legacy_decision,r.comparison,r.usage,
	r.created_at,r.updated_at,r.finished_at`

func scanRun(r scanner) (Run, error) {
	var x Run
	var prop, val, leg, usage []byte
	err := r.Scan(&x.ID, &x.AgentID, &x.SnapshotID, &x.Trigger, &x.Status, &x.AttemptsMade, &x.MaxAttempts, &x.FollowupsUsed, &x.CancelRequested,
		&x.WaitReason, &x.WaitUntil, &x.StopReason, &prop, &val, &leg, &x.Comparison, &usage, &x.CreatedAt, &x.UpdatedAt, &x.FinishedAt)
	x.Proposal, x.Validation, x.LegacyDecision, x.Usage = prop, val, leg, usage
	if len(usage) == 0 {
		x.Usage = json.RawMessage(`{}`)
	}
	return x, err
}

// Claim leases the oldest runnable run this worker can execute. FOR UPDATE SKIP
// LOCKED makes concurrent claimers pick different runs, never the same one.
func (s *Store) Claim(ctx context.Context, workerID string, runtimes []string, lease time.Duration) (*Claim, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var runID int64
	err = tx.QueryRow(ctx, `SELECT r.id FROM runs r JOIN agents a ON a.id=r.agent_id
		WHERE r.status='queued' AND r.run_after<=now() AND (a.enabled OR r.trigger LIKE 'operator:%') AND a.runtime = ANY($1)
		ORDER BY r.run_after, r.id FOR UPDATE OF r SKIP LOCKED LIMIT 1`, runtimes).Scan(&runID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var c Claim
	var attemptNo int
	if err := tx.QueryRow(ctx, `UPDATE runs SET status='running', attempts_made=attempts_made+1, updated_at=now() WHERE id=$1 RETURNING attempts_made`, runID).Scan(&attemptNo); err != nil {
		return nil, err
	}
	var usage []byte
	if err := tx.QueryRow(ctx, `INSERT INTO attempts (run_id,attempt_no,worker_id,lease_expires_at)
		VALUES ($1,$2,$3, now() + make_interval(secs => $4)) RETURNING id,run_id,attempt_no,worker_id,fence,status,tool_calls,started_at,lease_expires_at,usage`,
		runID, attemptNo, workerID, lease.Seconds()).Scan(&c.Attempt.ID, &c.Attempt.RunID, &c.Attempt.AttemptNo, &c.Attempt.WorkerID, &c.Attempt.Fence,
		&c.Attempt.Status, &c.Attempt.ToolCalls, &c.Attempt.StartedAt, &c.Attempt.LeaseUntil, &usage); err != nil {
		return nil, err
	}
	c.Attempt.Usage = usage
	if c.Run, err = scanRun(tx.QueryRow(ctx, `SELECT `+runCols+` FROM runs r WHERE r.id=$1`, runID)); err != nil {
		return nil, err
	}
	if c.Agent, err = scanAgent(tx.QueryRow(ctx, `SELECT `+agentCols+` FROM agents WHERE id=$1`, c.Run.AgentID)); err != nil {
		return nil, err
	}
	var payload []byte
	if err := tx.QueryRow(ctx, `SELECT id,idem_key,instrument,granularity,event,source,payload,digest,taken_at FROM snapshots WHERE id=$1`, c.Run.SnapshotID).
		Scan(&c.Snapshot.ID, &c.Snapshot.IdemKey, &c.Snapshot.Instrument, &c.Snapshot.Granularity, &c.Snapshot.Event, &c.Snapshot.Source, &payload, &c.Snapshot.Digest, &c.Snapshot.TakenAt); err != nil {
		return nil, err
	}
	c.Snapshot.Payload = payload
	var notes []byte
	if err := tx.QueryRow(ctx, `SELECT notes FROM sessions WHERE id=(SELECT session_id FROM runs WHERE id=$1)`, runID).Scan(&notes); err != nil {
		return nil, err
	}
	c.Notes = notes
	if err := s.emit(ctx, tx, runID, &c.Attempt.ID, "claimed", map[string]any{"attempt": attemptNo, "worker": workerID}); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &c, nil
}

type live struct {
	runID           int64
	attemptStatus   string
	live            bool
	cancelRequested bool
	runStatus       string
	pendingWait     []byte
	toolCalls       int
	attemptNo       int
}

// lockAttempt loads and row-locks the attempt and its run. Anything but the
// current running, unexpired attempt with the matching fence is ErrStale.
func lockAttempt(ctx context.Context, tx pgx.Tx, attemptID, fence int64) (live, error) {
	var l live
	var f int64
	err := tx.QueryRow(ctx, `SELECT a.run_id,a.status,a.lease_expires_at > now(),r.cancel_requested,r.status,a.pending_wait,a.tool_calls,a.attempt_no,a.fence
		FROM attempts a JOIN runs r ON r.id=a.run_id WHERE a.id=$1 FOR UPDATE OF a, r`, attemptID).
		Scan(&l.runID, &l.attemptStatus, &l.live, &l.cancelRequested, &l.runStatus, &l.pendingWait, &l.toolCalls, &l.attemptNo, &f)
	if errors.Is(err, pgx.ErrNoRows) {
		return l, ErrStale
	}
	if err != nil {
		return l, err
	}
	if f != fence {
		return l, ErrStale
	}
	return l, nil
}

func (l live) current() error {
	if l.attemptStatus != "running" || !l.live {
		return ErrStale
	}
	return nil
}

// Heartbeat extends the lease and reports a pending cancellation.
func (s *Store) Heartbeat(ctx context.Context, attemptID, fence int64, lease time.Duration) (cancel bool, err error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	l, err := lockAttempt(ctx, tx, attemptID, fence)
	if err != nil {
		return false, err
	}
	if err := l.current(); err != nil {
		return false, err
	}
	if _, err := tx.Exec(ctx, `UPDATE attempts SET lease_expires_at = now() + make_interval(secs => $2) WHERE id=$1`, attemptID, lease.Seconds()); err != nil {
		return false, err
	}
	return l.cancelRequested, tx.Commit(ctx)
}

// AppendEvent records a worker-side step for an attempt it still owns.
func (s *Store) AppendEvent(ctx context.Context, attemptID, fence int64, kind string, payload json.RawMessage) (cancel bool, err error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	l, err := lockAttempt(ctx, tx, attemptID, fence)
	if err != nil {
		return false, err
	}
	if err := l.current(); err != nil {
		return false, err
	}
	if len(payload) == 0 {
		payload = json.RawMessage(`{}`)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO run_events (run_id,attempt_id,kind,payload) VALUES ($1,$2,$3,$4)`, l.runID, attemptID, kind, []byte(payload)); err != nil {
		return false, err
	}
	return l.cancelRequested, tx.Commit(ctx)
}

// ToolContext is what the tool gateway needs after authorization.
type ToolContext struct {
	RunID    int64
	Agent    Agent
	Snapshot Snapshot
}

// AuthorizeTool enforces the allowlist and budget at execution time, so a
// model asking for an undeclared tool never reaches an executor. Denials are
// logged as events.
func (s *Store) AuthorizeTool(ctx context.Context, attemptID, fence int64, name string, args json.RawMessage) (*ToolContext, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	l, err := lockAttempt(ctx, tx, attemptID, fence)
	if err != nil {
		return nil, err
	}
	if err := l.current(); err != nil {
		return nil, err
	}
	if l.cancelRequested {
		return nil, ErrCancelled
	}
	var tc ToolContext
	tc.RunID = l.runID
	var agentID string
	if err := tx.QueryRow(ctx, `SELECT agent_id, snapshot_id FROM runs WHERE id=$1`, l.runID).Scan(&agentID, &tc.Snapshot.ID); err != nil {
		return nil, err
	}
	if tc.Agent, err = scanAgent(tx.QueryRow(ctx, `SELECT `+agentCols+` FROM agents WHERE id=$1`, agentID)); err != nil {
		return nil, err
	}
	deny := func(reason string, sentinel error) (*ToolContext, error) {
		if err := s.emit(ctx, tx, l.runID, &attemptID, "tool_denied", map[string]any{"tool": name, "reason": reason}); err != nil {
			return nil, err
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return nil, sentinel
	}
	allowed := false
	for _, t := range tc.Agent.AllowedTools {
		if t == name {
			allowed = true
		}
	}
	if !allowed {
		return deny("not in the declared toolset", ErrForbidden)
	}
	if l.toolCalls >= tc.Agent.Budgets.MaxToolCalls {
		return deny(fmt.Sprintf("tool-call budget of %d exhausted", tc.Agent.Budgets.MaxToolCalls), ErrBudget)
	}
	if _, err := tx.Exec(ctx, `UPDATE attempts SET tool_calls=tool_calls+1 WHERE id=$1`, attemptID); err != nil {
		return nil, err
	}
	var payload []byte
	if err := tx.QueryRow(ctx, `SELECT instrument,granularity,payload,taken_at FROM snapshots WHERE id=$1`, tc.Snapshot.ID).
		Scan(&tc.Snapshot.Instrument, &tc.Snapshot.Granularity, &payload, &tc.Snapshot.TakenAt); err != nil {
		return nil, err
	}
	tc.Snapshot.Payload = payload
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &tc, nil
}

// SetPendingWait stores a follow-up request made through the schedule_followup tool.
func (s *Store) SetPendingWait(ctx context.Context, attemptID, fence int64, seconds int, reason string) error {
	if seconds < 10 || seconds > 3600 {
		return fmt.Errorf("follow-up delay must be 10-3600 seconds, got %d", seconds)
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	l, err := lockAttempt(ctx, tx, attemptID, fence)
	if err != nil {
		return err
	}
	if err := l.current(); err != nil {
		return err
	}
	b, _ := json.Marshal(map[string]any{"seconds": seconds, "reason": reason})
	if _, err := tx.Exec(ctx, `UPDATE attempts SET pending_wait=$2 WHERE id=$1`, attemptID, b); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

type CompleteInput struct {
	Proposal   *domain.Decision   `json:"proposal"`
	Usage      map[string]float64 `json:"usage"`
	StopReason string             `json:"stopReason"`
}

type CompleteOutcome struct {
	Status     string            `json:"status"` // succeeded | waiting_for_event
	Validation domain.Validation `json:"validation"`
	Duplicate  bool              `json:"duplicate,omitempty"`
}

func addUsage(existing []byte, add map[string]float64) []byte {
	m := map[string]float64{}
	_ = json.Unmarshal(existing, &m)
	for k, v := range add {
		m[k] += v
	}
	b, _ := json.Marshal(m)
	return b
}

func (s *Store) touchSession(ctx context.Context, tx pgx.Tx, runID int64, note map[string]any) error {
	b, _ := json.Marshal(note)
	_, err := tx.Exec(ctx, `UPDATE sessions SET notes = (
		SELECT COALESCE(jsonb_agg(e ORDER BY n), '[]'::jsonb) FROM (
			SELECT e, n FROM jsonb_array_elements(notes || $2::jsonb) WITH ORDINALITY t(e, n) ORDER BY n DESC LIMIT 20) x)
		WHERE id=(SELECT session_id FROM runs WHERE id=$1)`, runID, "["+string(b)+"]")
	return err
}

// Complete finishes an attempt. A cancelled run discards the proposal, a stale
// worker is rejected, and a repeat of an already-applied completion is a no-op.
func (s *Store) Complete(ctx context.Context, attemptID, fence int64, in CompleteInput) (*CompleteOutcome, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	l, err := lockAttempt(ctx, tx, attemptID, fence)
	if err != nil {
		return nil, err
	}
	if l.attemptStatus == "succeeded" || l.attemptStatus == "waiting" { // duplicate delivery of an applied completion
		var raw []byte
		_ = tx.QueryRow(ctx, `SELECT COALESCE(validation,'{}'::jsonb) FROM runs WHERE id=$1`, l.runID).Scan(&raw)
		out := &CompleteOutcome{Status: map[string]string{"succeeded": "succeeded", "waiting": "waiting_for_event"}[l.attemptStatus], Duplicate: true}
		_ = json.Unmarshal(raw, &out.Validation)
		return out, nil
	}
	if err := l.current(); err != nil {
		return nil, err
	}
	if l.cancelRequested {
		if err := s.finishCancelled(ctx, tx, l.runID, attemptID, "cancelled while running; proposal discarded"); err != nil {
			return nil, err
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return nil, ErrCancelled
	}

	var agent Agent
	var agentID string
	var payload []byte
	var taken time.Time
	var runUsage, attUsage []byte
	var snapInstrument, snapSource string
	var followups int
	if err := tx.QueryRow(ctx, `SELECT r.agent_id, sn.payload, sn.taken_at, sn.instrument, sn.source, r.usage, r.followups_used FROM runs r JOIN snapshots sn ON sn.id=r.snapshot_id WHERE r.id=$1`, l.runID).
		Scan(&agentID, &payload, &taken, &snapInstrument, &snapSource, &runUsage, &followups); err != nil {
		return nil, err
	}
	if agent, err = scanAgent(tx.QueryRow(ctx, `SELECT `+agentCols+` FROM agents WHERE id=$1`, agentID)); err != nil {
		return nil, err
	}
	_ = attUsage
	proposal := domain.Hold("fail-safe hold: agent returned no proposal")
	if in.Proposal != nil {
		proposal = *in.Proposal
	}
	var pm map[string]any
	_ = json.Unmarshal(payload, &pm)
	maxAge := time.Duration(agent.Budgets.FreshnessSeconds) * time.Second
	var val domain.Validation
	wake := domain.WakeFromPayload(pm)
	if wake != nil {
		// a tripwire wake has its own, narrower action set
		val = domain.ValidateWake(proposal, *wake, taken, time.Now(), maxAge)
	} else {
		val = domain.ValidateProposal(proposal, domain.FactsFromPayload(snapInstrument, pm, taken), time.Now(), maxAge)
	}
	if !val.Valid {
		// an invalid proposal can never stand: record it, but the outcome is a hold
		if err := s.emit(ctx, tx, l.runID, &attemptID, "proposal_rejected", map[string]any{"proposal": proposal, "validation": val}); err != nil {
			return nil, err
		}
	}
	propJSON, _ := json.Marshal(proposal)
	valJSON, _ := json.Marshal(val)
	usageJSON := addUsage(runUsage, in.Usage)
	attemptUsage, _ := json.Marshal(in.Usage)

	out := &CompleteOutcome{Validation: val}
	var wait struct {
		Seconds int    `json:"seconds"`
		Reason  string `json:"reason"`
	}
	hasWait := len(l.pendingWait) > 0 && json.Unmarshal(l.pendingWait, &wait) == nil && wait.Seconds > 0
	if hasWait && followups < agent.Budgets.MaxFollowups {
		out.Status = "waiting_for_event"
		if _, err := tx.Exec(ctx, `UPDATE attempts SET status='waiting', ended_at=now(), usage=$2 WHERE id=$1`, attemptID, attemptUsage); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `UPDATE runs SET status='waiting_for_event', followups_used=followups_used+1, wait_reason=$2,
			wait_until = now() + make_interval(secs => $3), proposal=$4, validation=$5, usage=$6, updated_at=now() WHERE id=$1`,
			l.runID, wait.Reason, float64(wait.Seconds), propJSON, valJSON, usageJSON); err != nil {
			return nil, err
		}
		if err := s.emit(ctx, tx, l.runID, &attemptID, "interim_proposal", map[string]any{"proposal": proposal, "validation": val}); err != nil {
			return nil, err
		}
		if err := s.emit(ctx, tx, l.runID, &attemptID, "waiting", map[string]any{"seconds": wait.Seconds, "reason": wait.Reason}); err != nil {
			return nil, err
		}
	} else {
		out.Status = "succeeded"
		if _, err := tx.Exec(ctx, `UPDATE attempts SET status='succeeded', ended_at=now(), usage=$2 WHERE id=$1`, attemptID, attemptUsage); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `UPDATE runs SET status='succeeded', stop_reason=$2, wait_until=NULL, wait_reason=NULL, proposal=$3, validation=$4, usage=$5,
			updated_at=now(), finished_at=now() WHERE id=$1`, l.runID, orDefault(in.StopReason, "completed"), propJSON, valJSON, usageJSON); err != nil {
			return nil, err
		}
		if err := s.emit(ctx, tx, l.runID, &attemptID, "proposal", map[string]any{"proposal": proposal, "validation": val}); err != nil {
			return nil, err
		}
		// a final, valid result moves the shadow book: a wake acts on its position, an engine entry opens one
		switch {
		case wake != nil && val.Valid:
			if err := applyWakeTx(ctx, tx, l.runID, *wake, proposal, val.PriceUsed, time.Now()); err != nil {
				return nil, err
			}
		case wake != nil:
			if err := addPositionEvent(ctx, tx, wake.ID, "wake_hold", map[string]any{"runId": l.runID, "tripwire": wake.Alert, "rejected": val.Reasons}); err != nil {
				return nil, err
			}
		case val.Valid && proposal.Action == "open" && snapSource == "engine":
			if err := openPositionTx(ctx, tx, l.runID, agent, proposal, val.PriceUsed, taken); err != nil {
				return nil, err
			}
		}
	}
	if err := s.recompute(ctx, tx, l.runID); err != nil {
		return nil, err
	}
	if err := s.touchSession(ctx, tx, l.runID, map[string]any{"run": l.runID, "at": time.Now().UTC().Format(time.RFC3339), "action": proposal.Action, "reasoning": proposal.Reasoning, "followup": wait.Reason}); err != nil {
		return nil, err
	}
	if err := s.emit(ctx, tx, l.runID, &attemptID, "status", map[string]any{"status": out.Status}); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func orDefault(v, d string) string {
	if v == "" {
		return d
	}
	return v
}

func (s *Store) finishCancelled(ctx context.Context, tx pgx.Tx, runID, attemptID int64, reason string) error {
	if attemptID > 0 {
		if _, err := tx.Exec(ctx, `UPDATE attempts SET status='cancelled', ended_at=now() WHERE id=$1 AND status='running'`, attemptID); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE runs SET status='cancelled', stop_reason=$2, wait_until=NULL, updated_at=now(), finished_at=now() WHERE id=$1`, runID, reason); err != nil {
		return err
	}
	if err := s.recompute(ctx, tx, runID); err != nil {
		return err
	}
	return s.emit(ctx, tx, runID, nil, "status", map[string]any{"status": "cancelled", "reason": reason})
}

// Fail ends an attempt with an error. Retryable failures requeue with backoff
// until attempts are exhausted; the terminal outcome is always a recorded hold.
func (s *Store) Fail(ctx context.Context, attemptID, fence int64, msg string, retryable bool) (string, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	l, err := lockAttempt(ctx, tx, attemptID, fence)
	if err != nil {
		return "", err
	}
	if err := l.current(); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `UPDATE attempts SET status='failed', ended_at=now(), error=$2 WHERE id=$1`, attemptID, msg); err != nil {
		return "", err
	}
	if l.cancelRequested {
		if err := s.finishCancelled(ctx, tx, l.runID, 0, "cancelled; attempt failed: "+msg); err != nil {
			return "", err
		}
		return "cancelled", tx.Commit(ctx)
	}
	status, err := s.requeueOrFail(ctx, tx, l.runID, attemptID, msg, retryable)
	if err != nil {
		return "", err
	}
	return status, tx.Commit(ctx)
}

func (s *Store) requeueOrFail(ctx context.Context, tx pgx.Tx, runID, attemptID int64, msg string, retryable bool) (string, error) {
	var made, max int
	// follow-up wakes are not retries, so they do not count against max_attempts
	if err := tx.QueryRow(ctx, `SELECT attempts_made - followups_used, max_attempts FROM runs WHERE id=$1`, runID).Scan(&made, &max); err != nil {
		return "", err
	}
	if retryable && made < max {
		backoff := float64(int(2) << made) // 4s, 8s, 16s
		if _, err := tx.Exec(ctx, `UPDATE runs SET status='queued', run_after = now() + make_interval(secs => $2), updated_at=now() WHERE id=$1`, runID, backoff); err != nil {
			return "", err
		}
		return "queued", s.emit(ctx, tx, runID, &attemptID, "retry", map[string]any{"error": msg, "backoffSeconds": backoff})
	}
	hold := domain.Hold("fail-safe hold: " + msg)
	pj, _ := json.Marshal(hold)
	vj, _ := json.Marshal(domain.Validation{Valid: true, Reasons: []string{"fail-safe hold recorded; nothing to execute"}, Committed: false})
	if _, err := tx.Exec(ctx, `UPDATE runs SET status='failed', stop_reason=$2, proposal=$3, validation=$4, updated_at=now(), finished_at=now() WHERE id=$1`, runID, msg, pj, vj); err != nil {
		return "", err
	}
	if err := s.recompute(ctx, tx, runID); err != nil {
		return "", err
	}
	return "failed", s.emit(ctx, tx, runID, &attemptID, "status", map[string]any{"status": "failed", "reason": msg})
}

// AckCancel is the worker confirming it stopped after a cancel request.
func (s *Store) AckCancel(ctx context.Context, attemptID, fence int64) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	l, err := lockAttempt(ctx, tx, attemptID, fence)
	if err != nil {
		return err
	}
	if l.attemptStatus != "running" {
		return nil // already resolved (lease reaper or duplicate ack)
	}
	if err := s.finishCancelled(ctx, tx, l.runID, attemptID, "cancelled by operator"); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Cancel stops a run. Runs that are not executing end immediately; a running
// attempt is told at its next heartbeat, tool call or completion.
func (s *Store) Cancel(ctx context.Context, runID int64) (string, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var status string
	if err := tx.QueryRow(ctx, `SELECT status FROM runs WHERE id=$1 FOR UPDATE`, runID).Scan(&status); err != nil {
		return "", ErrNotFound
	}
	switch status {
	case "queued", "waiting_for_event", "awaiting_approval":
		if err := s.finishCancelled(ctx, tx, runID, 0, "cancelled by operator"); err != nil {
			return "", err
		}
		return "cancelled", tx.Commit(ctx)
	case "running":
		if _, err := tx.Exec(ctx, `UPDATE runs SET cancel_requested=true, updated_at=now() WHERE id=$1`, runID); err != nil {
			return "", err
		}
		if err := s.emit(ctx, tx, runID, nil, "cancel_requested", map[string]any{}); err != nil {
			return "", err
		}
		return "cancel_requested", tx.Commit(ctx)
	}
	return status, ErrTerminal
}

type ReapResult struct{ Expired, Woken, Aged int }

// Reap resolves expired leases, wakes due follow-ups and expires runs that
// waited in the queue past their deadline.
func (s *Store) Reap(ctx context.Context) (ReapResult, error) {
	var r ReapResult
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return r, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	rows, err := tx.Query(ctx, `SELECT a.id, a.run_id FROM attempts a WHERE a.status='running' AND a.lease_expires_at < now() FOR UPDATE SKIP LOCKED`)
	if err != nil {
		return r, err
	}
	type pair struct{ attempt, run int64 }
	var dead []pair
	for rows.Next() {
		var p pair
		if err := rows.Scan(&p.attempt, &p.run); err != nil {
			rows.Close()
			return r, err
		}
		dead = append(dead, p)
	}
	rows.Close()
	for _, p := range dead {
		var cancel bool
		if err := tx.QueryRow(ctx, `SELECT cancel_requested FROM runs WHERE id=$1 FOR UPDATE`, p.run).Scan(&cancel); err != nil {
			return r, err
		}
		if _, err := tx.Exec(ctx, `UPDATE attempts SET status='expired', ended_at=now(), error='lease expired' WHERE id=$1`, p.attempt); err != nil {
			return r, err
		}
		if cancel {
			if err := s.finishCancelled(ctx, tx, p.run, 0, "cancelled; worker lease expired"); err != nil {
				return r, err
			}
		} else if _, err := s.requeueOrFail(ctx, tx, p.run, p.attempt, "worker lease expired", true); err != nil {
			return r, err
		}
		r.Expired++
	}
	woke, err := tx.Query(ctx, `UPDATE runs SET status='queued', run_after=now(), wait_until=NULL, updated_at=now()
		WHERE status='waiting_for_event' AND wait_until <= now() RETURNING id, COALESCE(wait_reason,'')`)
	if err != nil {
		return r, err
	}
	type w struct {
		id     int64
		reason string
	}
	var ws []w
	for woke.Next() {
		var x w
		if err := woke.Scan(&x.id, &x.reason); err != nil {
			woke.Close()
			return r, err
		}
		ws = append(ws, x)
	}
	woke.Close()
	for _, x := range ws {
		if err := s.emit(ctx, tx, x.id, nil, "woken", map[string]any{"reason": x.reason}); err != nil {
			return r, err
		}
		r.Woken++
	}
	aged, err := tx.Query(ctx, `SELECT r.id FROM runs r JOIN agents a ON a.id=r.agent_id
		WHERE r.status='queued' AND r.run_after + make_interval(secs => COALESCE((a.budgets->>'deadlineSeconds')::int, 900)) < now() FOR UPDATE OF r SKIP LOCKED`)
	if err != nil {
		return r, err
	}
	var old []int64
	for aged.Next() {
		var id int64
		if err := aged.Scan(&id); err != nil {
			aged.Close()
			return r, err
		}
		old = append(old, id)
	}
	aged.Close()
	for _, id := range old {
		hold := domain.Hold("fail-safe hold: expired in the queue before any worker claimed it")
		pj, _ := json.Marshal(hold)
		vj, _ := json.Marshal(domain.Validation{Valid: true, Reasons: []string{"expired before execution; nothing to execute"}})
		if _, err := tx.Exec(ctx, `UPDATE runs SET status='expired', stop_reason='expired in queue', proposal=$2, validation=$3, updated_at=now(), finished_at=now() WHERE id=$1`, id, pj, vj); err != nil {
			return r, err
		}
		if err := s.recompute(ctx, tx, id); err != nil {
			return r, err
		}
		if err := s.emit(ctx, tx, id, nil, "status", map[string]any{"status": "expired", "reason": "expired in queue"}); err != nil {
			return r, err
		}
		r.Aged++
	}
	return r, tx.Commit(ctx)
}
