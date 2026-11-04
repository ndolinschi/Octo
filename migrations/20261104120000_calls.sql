CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT,
    token_hash TEXT,
    message TEXT,
    input TEXT NOT NULL,
    output TEXT NOT NULL,
    status INTEGER NOT NULL,
    latency_ms INTEGER NOT NULL,
    request_bytes INTEGER NOT NULL,
    response_bytes INTEGER NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost REAL
);
CREATE INDEX IF NOT EXISTS calls_token_hash ON calls(token_hash);
CREATE INDEX IF NOT EXISTS calls_kind_created ON calls(kind, created_at);
