-- Paper ledger. Money and prices are double precision, as in the Node ledger (scripts/portfolio.mjs).
-- A closed position keeps its row (closed_at set), so each trade references exactly one position.
CREATE TABLE ledger_account (
  id               smallint PRIMARY KEY CHECK (id = 1),
  starting_balance double precision NOT NULL,
  cash             double precision NOT NULL,
  halted           boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_positions (
  id           bigserial PRIMARY KEY,
  instrument   text NOT NULL,
  side         text NOT NULL CHECK (side IN ('long', 'short')),
  notional     double precision NOT NULL,
  units        double precision NOT NULL,
  entry_price  double precision NOT NULL,
  entry_time   timestamptz NOT NULL,
  leverage     double precision NOT NULL,
  margin       double precision NOT NULL,
  stop         double precision NOT NULL,
  target       double precision,
  last_mark    double precision NOT NULL,
  last_mark_at timestamptz NOT NULL,
  granularity  text,
  parent_id    bigint REFERENCES ledger_positions (id),
  closed_at    timestamptz
);

-- UNIQUE (position_id) refuses a second close of the same position.
CREATE TABLE ledger_trades (
  id           bigserial PRIMARY KEY,
  position_id  bigint NOT NULL UNIQUE REFERENCES ledger_positions (id),
  instrument   text NOT NULL,
  side         text NOT NULL,
  notional     double precision NOT NULL,
  units        double precision NOT NULL,
  entry_price  double precision NOT NULL,
  entry_time   timestamptz NOT NULL,
  close_price  double precision NOT NULL,
  close_time   timestamptz NOT NULL,
  leverage     double precision NOT NULL,
  realized     double precision NOT NULL,
  close_reason text NOT NULL,
  granularity  text
);

CREATE TABLE ledger_journal (
  id              bigserial PRIMARY KEY,
  at              timestamptz NOT NULL,
  action          text NOT NULL,
  position_id     bigint,
  reason          text,
  context         jsonb,
  idempotency_key text
);

-- One row per applied operation. A repeated key replays the stored result and writes nothing.
CREATE TABLE ledger_requests (
  idempotency_key text PRIMARY KEY,
  op              text NOT NULL,
  position_id     bigint,
  created_at      timestamptz NOT NULL DEFAULT now()
);
