-- Instruments, market data and the history imported from the legacy SQLite
-- engine. Imported rows are immutable history and carry a natural or source key
-- so the importer can run again and only add what is new.

CREATE TABLE instruments (
  symbol     text PRIMARY KEY,
  name       text NOT NULL,
  market     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE candles (
  instrument  text NOT NULL,
  granularity text NOT NULL,
  time        timestamptz NOT NULL,
  open        double precision NOT NULL,
  high        double precision NOT NULL,
  low         double precision NOT NULL,
  close       double precision NOT NULL,
  volume      double precision,
  PRIMARY KEY (instrument, granularity, time)
);

CREATE TABLE signals (
  instrument  text NOT NULL,
  granularity text NOT NULL,
  time        timestamptz NOT NULL,
  kind        text NOT NULL,
  signal      text NOT NULL,
  price       double precision,
  win_rate    double precision,
  verdict     text,
  reason      text,
  notified    boolean NOT NULL DEFAULT false,
  PRIMARY KEY (instrument, granularity, time, kind)
);

-- The engine's frozen decision-point state for a signal. Distinct from
-- `snapshots`, which belongs to agent runs.
CREATE TABLE signal_snapshots (
  instrument           text NOT NULL,
  granularity          text NOT NULL,
  time                 timestamptz NOT NULL,
  schema_version       int NOT NULL,
  snapshot             jsonb NOT NULL,
  filter_verdict       text,
  filter_model         text,
  filter_prompt_hash   text,
  filter_prompt_version text,
  context              jsonb,
  PRIMARY KEY (instrument, granularity, time)
);

-- Versioned strategy prompts. Every version is kept; `active` marks the
-- version the legacy engine currently runs.
CREATE TABLE strategies (
  name        text NOT NULL,
  version     int NOT NULL,
  prompt      text NOT NULL,
  spec        jsonb,
  instruments text,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL,
  active      boolean NOT NULL,
  archived    boolean NOT NULL,
  instrument  text,
  granularity text,
  dedicated   boolean NOT NULL,
  PRIMARY KEY (name, version)
);

-- One row per closed paper trade.
CREATE TABLE trades (
  source_key    text PRIMARY KEY,
  position_id   bigint NOT NULL,
  instrument    text NOT NULL,
  granularity   text,
  side          text NOT NULL CHECK (side IN ('long', 'short')),
  notional      double precision NOT NULL,
  units         double precision NOT NULL,
  entry_price   double precision NOT NULL,
  entry_time    timestamptz NOT NULL,
  close_price   double precision NOT NULL,
  close_time    timestamptz NOT NULL,
  leverage      double precision NOT NULL,
  realized      double precision NOT NULL,
  close_reason  text NOT NULL,
  strategy_hash text,
  strategy_name text
);
CREATE INDEX trades_instrument_idx ON trades (instrument, close_time);

-- Every bot deliberation and portfolio action, kept read-only.
CREATE TABLE bot_journal (
  source_key  text PRIMARY KEY,
  at          timestamptz NOT NULL,
  action      text NOT NULL,
  position_id bigint,
  reason      text,
  context     jsonb
);
CREATE INDEX bot_journal_at_idx ON bot_journal (at);

CREATE TABLE portfolio_account (
  id               int PRIMARY KEY CHECK (id = 1),
  starting_balance double precision NOT NULL,
  cash             double precision NOT NULL,
  halted           boolean NOT NULL,
  peak_equity      double precision,
  created_at       timestamptz NOT NULL
);

CREATE TABLE chat_threads (
  source_key  text PRIMARY KEY,
  title       text NOT NULL,
  instrument  text,
  granularity text,
  created_at  timestamptz NOT NULL
);

CREATE TABLE chat_messages (
  source_key text PRIMARY KEY,
  thread_key text NOT NULL REFERENCES chat_threads(source_key) ON DELETE CASCADE,
  role       text NOT NULL,
  content    text NOT NULL,
  context    jsonb,
  created_at timestamptz NOT NULL
);
CREATE INDEX chat_messages_thread_idx ON chat_messages (thread_key, created_at);

-- Standing rules the trader saved. Scope is global until scoped rules exist.
CREATE TABLE standing_rules (
  source_key text PRIMARY KEY,
  content    text NOT NULL,
  weight     int NOT NULL,
  source     text NOT NULL,
  archived   boolean NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE prompt_versions (
  gate       text NOT NULL,
  version    int NOT NULL,
  prompt     text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  active     boolean NOT NULL,
  PRIMARY KEY (gate, version)
);

CREATE TABLE rechecks (
  source_key     text PRIMARY KEY,
  instrument     text NOT NULL,
  granularity    text NOT NULL,
  signal_time    timestamptz NOT NULL,
  at             timestamptz NOT NULL,
  verdict        text NOT NULL,
  reason         text,
  prompt_version text
);

-- Which agent trades which instrument with which strategy. Imported from the
-- legacy bot map. Agents themselves stay in `agents`.
ALTER TABLE agents ADD COLUMN legacy_bot boolean NOT NULL DEFAULT false;

-- What each import run did, so a re-run is auditable.
CREATE TABLE import_runs (
  id         bigserial PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  source     text NOT NULL,
  dry_run    boolean NOT NULL,
  report     jsonb NOT NULL
);
