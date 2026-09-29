// Package queue is the Postgres-backed run queue: transactional enqueue,
// claims with expiring leases and fencing tokens, cancellation and expiry.
package queue

import (
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// MaxSnapshotBytes caps a frozen snapshot when it is created, so reading it back
// can always return whole, valid JSON.
const MaxSnapshotBytes = 64000

var (
	// ErrStale rejects a worker whose attempt was reassigned, expired or finished.
	ErrStale = errors.New("stale attempt: fence mismatch, lease expired or attempt no longer running")
	// ErrCancelled tells a worker the operator cancelled the run.
	ErrCancelled = errors.New("run cancelled")
	// ErrForbidden is a tool call outside the agent's allowlist.
	ErrForbidden = errors.New("tool not in the agent's allowlist")
	// ErrBudget is an exhausted per-attempt tool budget.
	ErrBudget = errors.New("tool-call budget exhausted")
	// ErrNotFound is an unknown run or agent.
	ErrNotFound = errors.New("not found")
	// ErrTerminal is a cancel on a finished run.
	ErrTerminal = errors.New("run already finished")
)

type Store struct{ Pool *pgxpool.Pool }

func New(pool *pgxpool.Pool) *Store { return &Store{Pool: pool} }

// Budgets bounds one agent. Zero values fall back to Defaults.
type Budgets struct {
	MaxToolCalls     int `json:"maxToolCalls"`
	MaxRounds        int `json:"maxRounds"`
	MaxAttempts      int `json:"maxAttempts"`
	MaxFollowups     int `json:"maxFollowups"`
	DeadlineSeconds  int `json:"deadlineSeconds"`  // max time a run may sit queued
	FreshnessSeconds int `json:"freshnessSeconds"` // max snapshot age at completion
	LeaseSeconds     int `json:"leaseSeconds"`
}

func (b Budgets) WithDefaults() Budgets {
	def := func(v *int, d int) {
		if *v <= 0 {
			*v = d
		}
	}
	def(&b.MaxToolCalls, 12)
	def(&b.MaxRounds, 6)
	def(&b.MaxAttempts, 3)
	def(&b.MaxFollowups, 2)
	def(&b.DeadlineSeconds, 900)
	def(&b.FreshnessSeconds, 900)
	def(&b.LeaseSeconds, 30)
	return b
}

type Agent struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Instrument   string   `json:"instrument"`
	Granularity  string   `json:"granularity"`
	Runtime      string   `json:"runtime"`
	Model        string   `json:"model,omitempty"`
	StrategyName string   `json:"strategyName,omitempty"`
	AllowedTools []string `json:"allowedTools"`
	Budgets      Budgets  `json:"budgets"`
	Enabled      bool     `json:"enabled"`
}

type Snapshot struct {
	ID          int64           `json:"id"`
	IdemKey     string          `json:"idemKey"`
	Instrument  string          `json:"instrument"`
	Granularity string          `json:"granularity"`
	Event       string          `json:"event"`
	Source      string          `json:"source"`
	Payload     json.RawMessage `json:"payload"`
	Digest      string          `json:"digest"`
	TakenAt     time.Time       `json:"takenAt"`
}

type Run struct {
	ID              int64           `json:"id"`
	AgentID         string          `json:"agentId"`
	SnapshotID      int64           `json:"snapshotId"`
	Trigger         string          `json:"trigger"`
	Status          string          `json:"status"`
	AttemptsMade    int             `json:"attemptsMade"`
	MaxAttempts     int             `json:"maxAttempts"`
	FollowupsUsed   int             `json:"followupsUsed"`
	CancelRequested bool            `json:"cancelRequested"`
	WaitReason      string          `json:"waitReason,omitempty"`
	WaitUntil       *time.Time      `json:"waitUntil,omitempty"`
	StopReason      string          `json:"stopReason,omitempty"`
	Proposal        json.RawMessage `json:"proposal,omitempty"`
	Validation      json.RawMessage `json:"validation,omitempty"`
	LegacyDecision  json.RawMessage `json:"legacyDecision,omitempty"`
	Comparison      string          `json:"comparison"`
	Usage           json.RawMessage `json:"usage"`
	CreatedAt       time.Time       `json:"createdAt"`
	UpdatedAt       time.Time       `json:"updatedAt"`
	FinishedAt      *time.Time      `json:"finishedAt,omitempty"`
}

type Attempt struct {
	ID         int64           `json:"id"`
	RunID      int64           `json:"runId"`
	AttemptNo  int             `json:"attemptNo"`
	WorkerID   string          `json:"workerId"`
	Fence      int64           `json:"fence,omitempty"` // only returned to the owning worker
	Status     string          `json:"status"`
	ToolCalls  int             `json:"toolCalls"`
	StartedAt  time.Time       `json:"startedAt"`
	EndedAt    *time.Time      `json:"endedAt,omitempty"`
	LeaseUntil time.Time       `json:"leaseUntil"`
	Error      string          `json:"error,omitempty"`
	Usage      json.RawMessage `json:"usage"`
}

type Event struct {
	ID        int64           `json:"id"`
	RunID     int64           `json:"runId"`
	AttemptID *int64          `json:"attemptId,omitempty"`
	Kind      string          `json:"kind"`
	Payload   json.RawMessage `json:"payload"`
	At        time.Time       `json:"at"`
}

// Claim is everything a worker needs to execute one attempt.
type Claim struct {
	Run      Run             `json:"run"`
	Attempt  Attempt         `json:"attempt"`
	Snapshot Snapshot        `json:"snapshot"`
	Agent    Agent           `json:"agent"`
	Notes    json.RawMessage `json:"notes"` // durable session notes from earlier runs and attempts
}
