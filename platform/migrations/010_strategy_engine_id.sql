-- The engine's SQLite row id of a mirrored strategy version. A legacy bot config names a strategy
-- by this id, so the Go resolution follows it to the strategy name. NULL for a console version.
ALTER TABLE strategies ADD COLUMN engine_id bigint UNIQUE;
