-- Typed settings store. Every write that changes at least one key adds one revision row,
-- and each settings row names the revision that last set it. The current revision is the
-- highest revision row. settings.json stays the live source until the Go store owns writes.
CREATE TABLE settings_revisions (
  revision   bigserial PRIMARY KEY,
  source     text NOT NULL CHECK (source IN ('import', 'api', 'operator')),
  keys       text[] NOT NULL CHECK (cardinality(keys) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE settings (
  key      text PRIMARY KEY,
  value    jsonb NOT NULL,
  revision bigint NOT NULL REFERENCES settings_revisions (revision)
);
