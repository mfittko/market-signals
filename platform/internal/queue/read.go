package queue

import (
	"context"
	"encoding/json"
	"time"
)

// RunRow is the list-view shape: a run joined to its agent and snapshot.
type RunRow struct {
	Run
	AgentName   string    `json:"agentName"`
	Runtime     string    `json:"runtime"`
	Instrument  string    `json:"instrument"`
	Granularity string    `json:"granularity"`
	Event       string    `json:"event"`
	Source      string    `json:"source"`
	SnapTakenAt time.Time `json:"snapshotTakenAt"`
}

type RunFilter struct {
	Status  string
	AgentID string
	Limit   int
}

func (s *Store) ListRuns(ctx context.Context, f RunFilter) ([]RunRow, error) {
	if f.Limit <= 0 || f.Limit > 200 {
		f.Limit = 50
	}
	rows, err := s.Pool.Query(ctx, `SELECT `+runCols+`, a.name, a.runtime, sn.instrument, sn.granularity, sn.event, sn.source, sn.taken_at
		FROM runs r JOIN agents a ON a.id=r.agent_id JOIN snapshots sn ON sn.id=r.snapshot_id
		WHERE ($1='' OR r.status=$1) AND ($2='' OR r.agent_id=$2) ORDER BY r.id DESC LIMIT $3`, f.Status, f.AgentID, f.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RunRow{}
	for rows.Next() {
		var x RunRow
		var prop, val, leg, usage []byte
		if err := rows.Scan(&x.ID, &x.AgentID, &x.SnapshotID, &x.Trigger, &x.Status, &x.AttemptsMade, &x.MaxAttempts, &x.FollowupsUsed, &x.CancelRequested,
			&x.WaitReason, &x.WaitUntil, &x.StopReason, &prop, &val, &leg, &x.Comparison, &usage, &x.CreatedAt, &x.UpdatedAt, &x.FinishedAt,
			&x.AgentName, &x.Runtime, &x.Instrument, &x.Granularity, &x.Event, &x.Source, &x.SnapTakenAt); err != nil {
			return nil, err
		}
		x.Proposal, x.Validation, x.LegacyDecision, x.Usage = prop, val, leg, usage
		out = append(out, x)
	}
	return out, rows.Err()
}

type RunDetail struct {
	Run      Run       `json:"run"`
	Agent    Agent     `json:"agent"`
	Snapshot Snapshot  `json:"snapshot"`
	Attempts []Attempt `json:"attempts"`
	Events   []Event   `json:"events"`
}

func (s *Store) GetRun(ctx context.Context, id int64) (*RunDetail, error) {
	var d RunDetail
	var err error
	if d.Run, err = scanRun(s.Pool.QueryRow(ctx, `SELECT `+runCols+` FROM runs r WHERE r.id=$1`, id)); err != nil {
		return nil, ErrNotFound
	}
	if d.Agent, err = s.GetAgent(ctx, d.Run.AgentID); err != nil {
		return nil, err
	}
	var payload []byte
	if err := s.Pool.QueryRow(ctx, `SELECT id,idem_key,instrument,granularity,event,source,payload,digest,taken_at FROM snapshots WHERE id=$1`, d.Run.SnapshotID).
		Scan(&d.Snapshot.ID, &d.Snapshot.IdemKey, &d.Snapshot.Instrument, &d.Snapshot.Granularity, &d.Snapshot.Event, &d.Snapshot.Source, &payload, &d.Snapshot.Digest, &d.Snapshot.TakenAt); err != nil {
		return nil, err
	}
	d.Snapshot.Payload = payload
	ar, err := s.Pool.Query(ctx, `SELECT id,run_id,attempt_no,worker_id,status,tool_calls,started_at,ended_at,lease_expires_at,COALESCE(error,''),usage FROM attempts WHERE run_id=$1 ORDER BY attempt_no`, id)
	if err != nil {
		return nil, err
	}
	defer ar.Close()
	d.Attempts = []Attempt{}
	for ar.Next() {
		var a Attempt
		var usage []byte
		if err := ar.Scan(&a.ID, &a.RunID, &a.AttemptNo, &a.WorkerID, &a.Status, &a.ToolCalls, &a.StartedAt, &a.EndedAt, &a.LeaseUntil, &a.Error, &usage); err != nil {
			return nil, err
		}
		a.Usage = usage
		d.Attempts = append(d.Attempts, a)
	}
	ar.Close()
	if d.Events, err = s.eventsQuery(ctx, `WHERE run_id=$1 AND id > $2`, id, 0, 2000); err != nil {
		return nil, err
	}
	return &d, nil
}

func (s *Store) eventsQuery(ctx context.Context, where string, arg any, after int64, limit int) ([]Event, error) {
	rows, err := s.Pool.Query(ctx, `SELECT id,run_id,attempt_id,kind,payload,at FROM run_events `+where+` ORDER BY id LIMIT $3`, arg, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Event{}
	for rows.Next() {
		var e Event
		var p []byte
		if err := rows.Scan(&e.ID, &e.RunID, &e.AttemptID, &e.Kind, &p, &e.At); err != nil {
			return nil, err
		}
		e.Payload = p
		out = append(out, e)
	}
	return out, rows.Err()
}

// EventsAfter is the durable catch-up read behind the live stream.
func (s *Store) EventsAfter(ctx context.Context, after int64, limit int) ([]Event, error) {
	return s.eventsQuery(ctx, `WHERE $1::bigint IS NOT NULL AND id > $2`, int64(0), after, limit)
}

type WorkerInfo struct {
	ID           string          `json:"id"`
	Runtimes     []string        `json:"runtimes"`
	Capabilities json.RawMessage `json:"capabilities"`
	LastSeen     time.Time       `json:"lastSeen"`
	Online       bool            `json:"online"`
}

type Stats struct {
	ByStatus  map[string]int `json:"byStatus"`
	Shadow    map[string]int `json:"shadow"`
	Invalid   int            `json:"invalidProposals"`
	QueueDeep int            `json:"queueDepth"`
	Workers   []WorkerInfo   `json:"workers"`
	LatestEvt int64          `json:"latestEventId"`
}

func (s *Store) Stats(ctx context.Context) (*Stats, error) {
	st := &Stats{ByStatus: map[string]int{}, Shadow: map[string]int{}, Workers: []WorkerInfo{}}
	rows, err := s.Pool.Query(ctx, `SELECT status, count(*) FROM runs GROUP BY status`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var k string
		var n int
		if err := rows.Scan(&k, &n); err != nil {
			rows.Close()
			return nil, err
		}
		st.ByStatus[k] = n
	}
	rows.Close()
	rows, err = s.Pool.Query(ctx, `SELECT comparison, count(*) FROM runs WHERE status IN ('succeeded','failed','expired') GROUP BY comparison`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var k string
		var n int
		if err := rows.Scan(&k, &n); err != nil {
			rows.Close()
			return nil, err
		}
		st.Shadow[k] = n
	}
	rows.Close()
	if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM runs WHERE (validation->>'valid')::boolean = false`).Scan(&st.Invalid); err != nil {
		return nil, err
	}
	st.QueueDeep = st.ByStatus["queued"]
	if err := s.Pool.QueryRow(ctx, `SELECT COALESCE(max(id),0) FROM run_events`).Scan(&st.LatestEvt); err != nil {
		return nil, err
	}
	wr, err := s.Pool.Query(ctx, `SELECT id,runtimes,capabilities,last_seen,last_seen > now() - interval '15 seconds' FROM workers ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer wr.Close()
	for wr.Next() {
		var w WorkerInfo
		var c []byte
		if err := wr.Scan(&w.ID, &w.Runtimes, &c, &w.LastSeen, &w.Online); err != nil {
			return nil, err
		}
		w.Capabilities = c
		st.Workers = append(st.Workers, w)
	}
	return st, wr.Err()
}
