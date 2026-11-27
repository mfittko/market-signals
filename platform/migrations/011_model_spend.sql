-- Model spend ledger: one row per Go model call that reached the provider. platform/internal/spend is its only
-- writer. Money is double precision, as in 008_ledger.sql. priced_as is the price table entry used, or *max*
-- for a model without an entry. A call without usage, with empty or all-zero usage, or one that timed out, is
-- estimated from max_tokens.
CREATE TABLE model_spend (
  id                bigserial PRIMARY KEY,
  at                timestamptz NOT NULL DEFAULT now(),
  call_site         text NOT NULL CHECK (call_site <> ''),
  provider          text NOT NULL,
  model             text NOT NULL,
  priced_as         text NOT NULL,
  prompt_tokens     bigint NOT NULL CHECK (prompt_tokens >= 0),
  completion_tokens bigint NOT NULL CHECK (completion_tokens >= 0),
  estimated         boolean NOT NULL DEFAULT false,
  cost_usd          double precision NOT NULL CHECK (cost_usd >= 0),
  run_id            bigint REFERENCES runs (id) ON DELETE SET NULL
);
CREATE INDEX model_spend_at_idx ON model_spend (at);
