-- Each run freezes its agent's console strategy (name, version, prompt) when it is enqueued. NULL means the
-- engine's strategy in the snapshot governs; runs created before this column keep NULL and their stored payload.
ALTER TABLE runs ADD COLUMN strategy jsonb;
