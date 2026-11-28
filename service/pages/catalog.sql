CREATE TABLE IF NOT EXISTS demo_strategy (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  creator TEXT NOT NULL,
  scenario TEXT NOT NULL CHECK (scenario IN ('scheduled', 'balanced')),
  created_at INTEGER NOT NULL,
  UNIQUE (name, creator, scenario)
);

CREATE INDEX IF NOT EXISTS demo_strategy_latest ON demo_strategy (created_at DESC, id);
