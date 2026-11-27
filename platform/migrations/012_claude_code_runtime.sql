-- The claude-code runtime runs agents through the local Claude Code CLI. Each of its calls writes a model_spend
-- row with provider and priced_as claude-code and cost 0, so the daily cap sum ignores it.
ALTER TABLE agents DROP CONSTRAINT agents_runtime_check;
ALTER TABLE agents ADD CONSTRAINT agents_runtime_check CHECK (runtime IN ('mock', 'llm', 'claude-code'));
