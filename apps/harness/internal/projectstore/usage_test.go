package projectstore

import (
	"context"
	"errors"
	"os"
	"testing"
)

const preUsageSchema = `
CREATE TABLE IF NOT EXISTS project (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	name TEXT NOT NULL,
	description TEXT NOT NULL,
	instructions TEXT NOT NULL,
	models_json TEXT NOT NULL,
	max_depth INTEGER NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS folders (
	id TEXT PRIMARY KEY,
	label TEXT NOT NULL UNIQUE,
	path TEXT NOT NULL,
	created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
	id TEXT PRIMARY KEY,
	parent_id TEXT,
	depth INTEGER NOT NULL,
	role TEXT NOT NULL,
	title TEXT NOT NULL,
	task TEXT NOT NULL,
	model TEXT NOT NULL,
	tier TEXT,
	status TEXT NOT NULL,
	result TEXT,
	error TEXT,
	spawn_tool_use_id TEXT,
	input_tokens INTEGER NOT NULL DEFAULT 0,
	output_tokens INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	started_at TEXT,
	finished_at TEXT
);
CREATE TABLE IF NOT EXISTS messages (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	agent_id TEXT NOT NULL,
	role TEXT NOT NULL,
	content_json TEXT NOT NULL,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_agent ON messages (agent_id, id);
CREATE TABLE IF NOT EXISTS notes (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	content TEXT NOT NULL,
	author TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);`

func TestMigrateOldDatabase(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()

	const id = "prj_old"
	if err := os.MkdirAll(s.projectDir(id), 0o755); err != nil {
		t.Fatal(err)
	}
	old, err := openSQLite(s.projectDir(id) + "/project.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		preUsageSchema,
		`INSERT INTO project VALUES (1, 'legacy', 'd', 'i', '{}', 3, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		`INSERT INTO folders VALUES ('fld_1', 'src', '/tmp/src', '2026-01-01T00:00:00.000Z')`,
		`INSERT INTO agents (id, depth, role, title, task, model, status, input_tokens, output_tokens, created_at)
		 VALUES ('agt_1', 0, 'orchestrator', '', '', 'm', 'idle', 70, 30, '2026-01-01T00:00:00.000Z')`,
		`INSERT INTO messages (agent_id, role, content_json, created_at) VALUES ('agt_1', 'user', '[]', '2026-01-01T00:00:00.000Z')`,
	} {
		if _, err := old.Exec(q); err != nil {
			t.Fatalf("seed %.40q: %v", q, err)
		}
	}
	if err := old.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.reg.Exec(`INSERT INTO projects VALUES (?, 'legacy', '2026-01-01T00:00:00.000Z')`, id); err != nil {
		t.Fatal(err)
	}

	check := func(s *Store) {
		t.Helper()
		db, err := s.Get(ctx, id)
		if err != nil {
			t.Fatalf("open old database: %v", err)
		}
		a, err := db.Agent(ctx, "agt_1")
		if err != nil || a.InputTokens != 70 || a.OutputTokens != 30 || a.ContextUsed != nil || a.ContextSize != nil {
			t.Fatalf("agent after migration = %+v, %v", a, err)
		}
		if info, err := db.Info(ctx); err != nil || info.Name != "legacy" {
			t.Fatalf("info = %+v, %v", info, err)
		}
		if f, err := db.Folders(ctx); err != nil || len(f) != 1 {
			t.Fatalf("folders = %+v, %v", f, err)
		}
		if m, err := db.Messages(ctx, "agt_1"); err != nil || len(m) != 1 {
			t.Fatalf("messages = %+v, %v", m, err)
		}
		before := a.InputTokens
		a, err = db.RecordUsage(ctx, UsageRecord{
			AgentID: "agt_1", Model: "m", Source: SourceAPI, InputTokens: 5, OutputTokens: 2,
			Context: &ContextWindow{Used: 10, Size: 100},
		})
		if err != nil || a.InputTokens != before+5 || a.ContextUsed == nil || *a.ContextUsed != 10 || *a.ContextSize != 100 {
			t.Fatalf("after RecordUsage = %+v, %v", a, err)
		}
	}
	check(s)

	// Reopening runs the migration again; it must be a no-op.
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s2, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s2.Close() }()
	db, err := s2.Get(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	rows, err := db.UsageRows(ctx, "0000", "9999", GroupModel)
	if err != nil || len(rows) != 1 || rows[0].Requests != 1 || rows[0].InputTokens != 5 {
		t.Fatalf("usage rows after reopen = %+v, %v", rows, err)
	}
	if err := db.migrate(ctx); err != nil {
		t.Fatalf("second migrate: %v", err)
	}
}

func TestRecordUsageUnknownAgent(t *testing.T) {
	db := create(t, newStore(t), "p")
	_, err := db.RecordUsage(context.Background(), UsageRecord{AgentID: "nope", Model: "m", Source: SourceAPI})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	rows, err := db.UsageRows(context.Background(), "0000", "9999", GroupDay)
	if err != nil || len(rows) != 0 {
		t.Fatalf("rolled-back usage rows = %+v, %v", rows, err)
	}
}

func TestUsageRowsGroups(t *testing.T) {
	ctx := context.Background()
	db := create(t, newStore(t), "proj")
	orch, err := db.Orchestrator(ctx)
	if err != nil {
		t.Fatal(err)
	}
	cost := 0.25
	recs := []UsageRecord{
		{AgentID: orch.ID, Model: "a", Source: SourceAPI, InputTokens: 10, OutputTokens: 1, CacheReadTokens: 4, CreatedAt: "2026-11-09T23:59:59.999Z"},
		{AgentID: orch.ID, Model: "a", Source: SourceAPI, InputTokens: 20, OutputTokens: 2, CacheWriteTokens: 3, CreatedAt: "2026-11-10T00:00:00.000Z"},
		{AgentID: orch.ID, Model: "acp:x", Source: SourceACP, InputTokens: 30, CostUSD: &cost, CreatedAt: "2026-11-10T12:00:00.000Z"},
		{AgentID: orch.ID, Model: "acp:x", Source: SourceACP, InputTokens: 5, CreatedAt: "2026-11-10T13:00:00.000Z"},
	}
	for _, r := range recs {
		if _, err := db.RecordUsage(ctx, r); err != nil {
			t.Fatal(err)
		}
	}
	day, err := db.UsageRows(ctx, "2026-11-10T00:00:00.000Z", "2026-11-11T00:00:00.000Z", GroupDay)
	if err != nil {
		t.Fatal(err)
	}
	var in, reqs int64
	for _, r := range day {
		if r.Key != "2026-11-10" {
			t.Errorf("day key = %q (from is inclusive, earlier row must be excluded)", r.Key)
		}
		in += r.InputTokens
		reqs += r.Requests
	}
	if in != 55 || reqs != 3 || len(day) != 3 {
		t.Fatalf("day rows = %+v (tokens %d, requests %d)", day, in, reqs)
	}
	agents, err := db.UsageRows(ctx, "0000", "9999", GroupAgent)
	if err != nil || len(agents) == 0 || agents[0].Key != orch.ID || agents[0].Label != "orchestrator" {
		t.Fatalf("agent rows = %+v, %v", agents, err)
	}
	proj, err := db.UsageRows(ctx, "0000", "9999", GroupProject)
	if err != nil || len(proj) == 0 || proj[0].Key != db.ID() || proj[0].Label != "proj" {
		t.Fatalf("project rows = %+v, %v", proj, err)
	}
	if _, err := db.UsageRows(ctx, "0000", "9999", "bogus"); err == nil {
		t.Fatal("unknown group accepted")
	}
}
