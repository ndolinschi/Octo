CREATE TABLE IF NOT EXISTS session_outcomes (
    session_id TEXT PRIMARY KEY NOT NULL,
    updated_at INTEGER NOT NULL,
    last_test_tool TEXT,
    tests_passed INTEGER NOT NULL DEFAULT 0,
    tests_failed INTEGER NOT NULL DEFAULT 0,
    tests_errors INTEGER NOT NULL DEFAULT 0,
    last_status TEXT NOT NULL DEFAULT 'unknown'
);
