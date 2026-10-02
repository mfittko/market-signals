-- Model verdicts per instrument and headline: English title, relevance, and a summary of the article.
-- The console reads these instead of asking the model again after a restart.
CREATE TABLE IF NOT EXISTS news_triage (
  instrument    text        NOT NULL,
  title         text        NOT NULL,
  title_en      text        NOT NULL DEFAULT '',
  relevant      boolean     NOT NULL,
  url           text,
  summary       text        NOT NULL DEFAULT '',
  summarized_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instrument, title)
);
