-- Agent runtime control plane. The deterministic engine stays authoritative;
-- this schema only records what agents were asked, did and proposed.

CREATE SEQUENCE fence_seq;

CREATE TABLE agents (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  instrument    text NOT NULL,
  granularity   text NOT NULL,
  runtime       text NOT NULL CHECK (runtime IN ('mock', 'llm')),
  model         text,
  strategy_name text,
  allowed_tools text[] NOT NULL,
  budgets       jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- One durable, scoped working context per agent.
CREATE TABLE sessions (
  id         bigserial PRIMARY KEY,
  agent_id   text NOT NULL UNIQUE REFERENCES agents(id) ON DELETE CASCADE,
  notes      jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The frozen decision-point state. Rows never change after insert.
CREATE TABLE snapshots (
  id          bigserial PRIMARY KEY,
  idem_key    text NOT NULL UNIQUE,
  instrument  text NOT NULL,
  granularity text NOT NULL,
  event       text NOT NULL,
  source      text NOT NULL CHECK (source IN ('engine', 'operator', 'demo')),
  payload     jsonb NOT NULL,
  digest      text NOT NULL,
  taken_at    timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION snapshots_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'snapshots are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER snapshots_no_update BEFORE UPDATE OR DELETE ON snapshots
  FOR EACH ROW EXECUTE FUNCTION snapshots_immutable();

CREATE TABLE runs (
  id               bigserial PRIMARY KEY,
  agent_id         text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  session_id       bigint NOT NULL REFERENCES sessions(id),
  snapshot_id      bigint NOT NULL REFERENCES snapshots(id),
  trigger          text NOT NULL,
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN
    ('queued', 'running', 'waiting_for_event', 'awaiting_approval',
     'succeeded', 'failed', 'cancelled', 'expired')),
  attempts_made    int NOT NULL DEFAULT 0,
  max_attempts     int NOT NULL DEFAULT 3,
  followups_used   int NOT NULL DEFAULT 0,
  cancel_requested boolean NOT NULL DEFAULT false,
  run_after        timestamptz NOT NULL DEFAULT now(),
  wait_reason      text,
  wait_until       timestamptz,
  stop_reason      text,
  proposal         jsonb,
  validation       jsonb,
  legacy_decision  jsonb,
  comparison       text NOT NULL DEFAULT 'pending' CHECK (comparison IN ('pending', 'agree', 'differ', 'no_legacy')),
  usage            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  UNIQUE (agent_id, snapshot_id)
);
CREATE INDEX runs_claim_idx ON runs (status, run_after) WHERE status IN ('queued', 'waiting_for_event');
CREATE INDEX runs_recent_idx ON runs (id DESC);

CREATE TABLE attempts (
  id               bigserial PRIMARY KEY,
  run_id           bigint NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  attempt_no       int NOT NULL,
  worker_id        text NOT NULL,
  fence            bigint NOT NULL DEFAULT nextval('fence_seq'),
  status           text NOT NULL DEFAULT 'running' CHECK (status IN
    ('running', 'succeeded', 'waiting', 'failed', 'cancelled', 'expired')),
  lease_expires_at timestamptz NOT NULL,
  pending_wait     jsonb,
  tool_calls       int NOT NULL DEFAULT 0,
  started_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  error            text,
  usage            jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (run_id, attempt_no)
);
CREATE INDEX attempts_lease_idx ON attempts (lease_expires_at) WHERE status = 'running';

-- Durable, ordered event log. The bigserial id is the catch-up cursor.
CREATE TABLE run_events (
  id         bigserial PRIMARY KEY,
  run_id     bigint NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  attempt_id bigint REFERENCES attempts(id) ON DELETE SET NULL,
  kind       text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX run_events_run_idx ON run_events (run_id, id);

CREATE TABLE workers (
  id           text PRIMARY KEY,
  runtimes     text[] NOT NULL,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen    timestamptz NOT NULL DEFAULT now()
);
