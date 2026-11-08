CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    session_id TEXT,
    purpose TEXT NOT NULL,
    model TEXT NOT NULL,
    status INTEGER NOT NULL,
    latency_ms INTEGER NOT NULL,
    user_text TEXT NOT NULL,
    is_hard INTEGER,
    is_easy INTEGER,
    tools_enough TEXT,
    complexity TEXT,
    choice_rule TEXT NOT NULL,
    missing_tools TEXT,
    request_payload TEXT NOT NULL,
    response_payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS decisions_session_created ON decisions(session_id, created_at);
