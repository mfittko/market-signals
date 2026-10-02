package queue

import (
	"context"
	"encoding/json"
	"errors"
)

// ErrUnknownStrategy: the agent names a strategy that does not exist or has every version archived.
var ErrUnknownStrategy = errors.New("unknown or archived strategy")

func (s *Store) UpsertAgent(ctx context.Context, a Agent) error {
	b, _ := json.Marshal(a.Budgets.WithDefaults())
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if a.StrategyName != "" {
		// an agent may only point at a strategy that has a live version; the per-strategy lock is the one
		// archiving takes, so an assignment cannot slip in between its "no agent uses it" check and its update
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, "strategy:"+a.StrategyName); err != nil {
			return err
		}
		var live bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM strategies WHERE name=$1 AND NOT archived)`, a.StrategyName).Scan(&live); err != nil {
			return err
		}
		if !live {
			return ErrUnknownStrategy
		}
	}
	_, err = tx.Exec(ctx, `INSERT INTO agents (id,name,instrument,granularity,runtime,model,strategy_name,allowed_tools,budgets,enabled)
		VALUES ($1,$2,$3,$4,$5,NULLIF($6,''),NULLIF($7,''),$8,$9,$10)
		ON CONFLICT (id) DO UPDATE SET name=$2, instrument=$3, granularity=$4, runtime=$5, model=NULLIF($6,''),
		  strategy_name=NULLIF($7,''), allowed_tools=$8, budgets=$9, enabled=$10`,
		a.ID, a.Name, a.Instrument, a.Granularity, a.Runtime, a.Model, a.StrategyName, a.AllowedTools, b, a.Enabled)
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO sessions (agent_id) VALUES ($1) ON CONFLICT (agent_id) DO NOTHING`, a.ID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

const agentCols = `id,name,instrument,granularity,runtime,COALESCE(model,''),COALESCE(strategy_name,''),allowed_tools,budgets,enabled`

type scanner interface{ Scan(dest ...any) error }

func scanAgent(r scanner) (Agent, error) {
	var a Agent
	var b []byte
	if err := r.Scan(&a.ID, &a.Name, &a.Instrument, &a.Granularity, &a.Runtime, &a.Model, &a.StrategyName, &a.AllowedTools, &b, &a.Enabled); err != nil {
		return a, err
	}
	_ = json.Unmarshal(b, &a.Budgets)
	a.Budgets = a.Budgets.WithDefaults()
	return a, nil
}

func (s *Store) ListAgents(ctx context.Context) ([]Agent, error) {
	rows, err := s.Pool.Query(ctx, `SELECT `+agentCols+` FROM agents ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Agent{}
	for rows.Next() {
		a, err := scanAgent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (s *Store) GetAgent(ctx context.Context, id string) (Agent, error) {
	a, err := scanAgent(s.Pool.QueryRow(ctx, `SELECT `+agentCols+` FROM agents WHERE id=$1`, id))
	if err != nil {
		return a, ErrNotFound
	}
	return a, nil
}

func (s *Store) SetEnabled(ctx context.Context, id string, enabled bool) error {
	tag, err := s.Pool.Exec(ctx, `UPDATE agents SET enabled=$2 WHERE id=$1`, id, enabled)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
