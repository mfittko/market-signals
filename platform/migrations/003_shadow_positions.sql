-- Shadow positions: what an agent's accepted entry would have become.
-- They are virtual and never reach the engine's ledger. A deterministic monitor
-- manages them from the exit plan; the model is woken only when a tripwire fires.

ALTER TABLE snapshots DROP CONSTRAINT snapshots_source_check;
ALTER TABLE snapshots ADD CONSTRAINT snapshots_source_check CHECK (source IN ('engine', 'operator', 'demo', 'monitor'));

CREATE TABLE shadow_positions (
  id            bigserial PRIMARY KEY,
  agent_id      text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  run_id        bigint NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  instrument    text NOT NULL,
  granularity   text NOT NULL,
  side          text NOT NULL CHECK (side IN ('long', 'short')),
  notional      double precision NOT NULL,
  entry_price   double precision NOT NULL,
  entry_time    timestamptz NOT NULL,
  initial_stop  double precision NOT NULL,
  stop          double precision NOT NULL,
  target        double precision,
  plan          jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- monitor state, advanced one completed bar at a time
  bars_held     int NOT NULL DEFAULT 0,
  best          double precision,
  last_close    double precision,
  last_bar_time timestamptz,
  last_fired    jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  exit_price    double precision,
  exit_time     timestamptz,
  exit_reason   text,
  realized      double precision,
  wakes         int NOT NULL DEFAULT 0,
  failed_wakes  int NOT NULL DEFAULT 0,
  needs_attention boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- one open position per agent, and one position per opening run
CREATE UNIQUE INDEX shadow_positions_one_open ON shadow_positions (agent_id) WHERE status = 'open';
CREATE UNIQUE INDEX shadow_positions_run ON shadow_positions (run_id);
CREATE INDEX shadow_positions_status ON shadow_positions (status, instrument);

CREATE TABLE position_events (
  id          bigserial PRIMARY KEY,
  position_id bigint NOT NULL REFERENCES shadow_positions(id) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT now(),
  kind        text NOT NULL, -- opened | trail | exit | wake | wake_skipped | wake_failed | wake_hold | wake_ignored | tighten | tripwires | attention
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX position_events_position ON position_events (position_id, id);
