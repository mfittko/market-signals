-- The newest bar Replay judged for a position. Replay judges only bars after it, so a restart
-- neither skips a completed bar nor judges one twice. NULL until the first replay.
ALTER TABLE ledger_positions ADD COLUMN last_judged_at timestamptz;
