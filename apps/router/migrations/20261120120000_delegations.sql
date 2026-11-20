CREATE TABLE IF NOT EXISTS delegations (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    budget_key TEXT NOT NULL,
    session_id TEXT,
    attempt INTEGER NOT NULL DEFAULT 1,
    escalated_from TEXT,
    title TEXT,
    brief TEXT,
    title_chars INTEGER NOT NULL DEFAULT 0,
    brief_chars INTEGER NOT NULL DEFAULT 0,
    brief_tokens INTEGER NOT NULL DEFAULT 0,
    brief_hash TEXT NOT NULL,
    text_features TEXT NOT NULL DEFAULT '{}',
    tools TEXT NOT NULL,
    tool_count INTEGER NOT NULL DEFAULT 0,
    depth INTEGER NOT NULL DEFAULT 0,
    parent_tier TEXT,
    candidates TEXT NOT NULL,
    exclude TEXT NOT NULL DEFAULT '[]',
    min_tier TEXT,
    choice TEXT NOT NULL,
    choice_kind TEXT NOT NULL,
    choice_tier TEXT,
    model TEXT,
    served_tier TEXT NOT NULL,
    band TEXT NOT NULL,
    reason TEXT NOT NULL,
    classifier TEXT NOT NULL,
    classifier_requested TEXT NOT NULL,
    classifier_version TEXT NOT NULL,
    classifier_status TEXT NOT NULL,
    fallback_reason TEXT,
    p_low REAL,
    p_mid REAL,
    p_high REAL,
    estimated_cost_micros INTEGER,
    classifier_cost_micros INTEGER NOT NULL DEFAULT 0,
    solved TEXT NOT NULL DEFAULT 'unknown',
    solved_rule TEXT NOT NULL DEFAULT 'no_outcome',
    solved_confidence TEXT NOT NULL DEFAULT 'none',
    outcome_at INTEGER
);
CREATE INDEX IF NOT EXISTS delegations_created ON delegations(created_at);
CREATE INDEX IF NOT EXISTS delegations_budget ON delegations(budget_key);
CREATE INDEX IF NOT EXISTS delegations_escalated_from ON delegations(escalated_from);

CREATE TABLE IF NOT EXISTS delegation_outcomes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL,
    report_id TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    event TEXT NOT NULL,
    body TEXT NOT NULL,
    UNIQUE(request_id, report_id)
);
CREATE INDEX IF NOT EXISTS delegation_outcomes_request ON delegation_outcomes(request_id);
