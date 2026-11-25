ALTER TABLE calls ADD COLUMN request_id TEXT;
CREATE INDEX IF NOT EXISTS calls_request_id ON calls(request_id);

CREATE TABLE IF NOT EXISTS autoroute_calls (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    session_id TEXT,
    budget_key TEXT,
    trigger TEXT NOT NULL,
    model TEXT NOT NULL,
    cost_micros INTEGER NOT NULL DEFAULT 0,
    record TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS autoroute_calls_created ON autoroute_calls(created_at);
CREATE INDEX IF NOT EXISTS autoroute_calls_budget ON autoroute_calls(budget_key);

CREATE TABLE IF NOT EXISTS budget_spend (
    budget_key TEXT PRIMARY KEY,
    spent_micros INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS budget_spend_updated ON budget_spend(updated_at);
