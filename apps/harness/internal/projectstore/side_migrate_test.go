package projectstore

import (
	"context"
	"os"
	"testing"
)

// i1Tail is what the router-integration release (I1) added to the older schema:
// the router columns on usage and the compactions table, still without
// usage_id, usage.role and side_messages.
const i1Tail = `
CREATE TABLE usage (
	id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, model TEXT NOT NULL, source TEXT NOT NULL,
	input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
	cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
	cost_usd REAL, created_at TEXT NOT NULL,
	served_model TEXT, tier TEXT, route_trigger TEXT, router_request_id TEXT, cost_estimated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX usage_created ON usage (created_at);
CREATE TABLE compactions (
	id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, summary TEXT NOT NULL,
	upto_message_id INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX compactions_agent ON compactions (agent_id, id);`

func TestMigrateFromRouterRelease(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	const id = "prj_i1"
	if err := os.MkdirAll(s.projectDir(id), 0o755); err != nil {
		t.Fatal(err)
	}
	old, err := openSQLite(s.projectDir(id) + "/project.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		preUsageSchema, i1Tail,
		`ALTER TABLE agents ADD COLUMN context_used INTEGER`, `ALTER TABLE agents ADD COLUMN context_size INTEGER`,
		`ALTER TABLE project ADD COLUMN budget_usd REAL`,
		`INSERT INTO project (id, name, description, instructions, models_json, max_depth, created_at, updated_at)
		 VALUES (1, 'i1', '', '', '{"orchestrator":"o","fast":"f","balanced":"b","deep":"d"}', 3, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		`INSERT INTO agents (id, depth, role, title, task, model, status, input_tokens, output_tokens, created_at)
		 VALUES ('agt_1', 0, 'orchestrator', '', '', 'm', 'idle', 70, 30, '2026-01-01T00:00:00.000Z')`,
		`INSERT INTO messages (agent_id, role, content_json, created_at) VALUES ('agt_1', 'user', '[]', '2026-01-01T00:00:00.000Z')`,
		`INSERT INTO usage (agent_id, model, source, input_tokens, output_tokens, created_at) VALUES ('agt_1', 'm', 'api', 400, 30, '2026-01-01T00:00:01.000Z')`,
		`INSERT INTO compactions (agent_id, summary, upto_message_id, created_at) VALUES ('agt_1', 'old summary', 1, '2026-01-01T00:00:02.000Z')`,
		`INSERT INTO usage (agent_id, model, source, input_tokens, output_tokens, created_at) VALUES ('agt_1', 'm', 'api', 50, 5, '2026-01-01T00:00:03.000Z')`,
	} {
		if _, err := old.Exec(q); err != nil {
			t.Fatalf("seed %.50q: %v", q, err)
		}
	}
	if err := old.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.reg.Exec(`INSERT INTO projects VALUES (?, 'i1', '2026-01-01T00:00:00.000Z')`, id); err != nil {
		t.Fatal(err)
	}

	check := func(s *Store) {
		t.Helper()
		db, err := s.Get(ctx, id)
		if err != nil {
			t.Fatalf("open I1 database: %v", err)
		}
		cs, err := db.Compactions(ctx, "agt_1")
		if err != nil || len(cs) != 1 || cs[0].Summary != "old summary" || cs[0].UptoMessageID != 1 || cs[0].UsageID != 0 || cs[0].SummaryTokens() != 3 {
			t.Fatalf("old compaction = %+v, %v", cs, err)
		}
		if rep, ok, err := db.LastReportedContext(ctx, "agt_1"); err != nil || !ok || rep.Tokens != 50 {
			t.Fatalf("reported context after migration = %+v ok=%v err=%v, want the row after the old compaction", rep, ok, err)
		}
		if m, err := db.SideMessages(ctx); err != nil || len(m) != 0 {
			t.Fatalf("side messages = %+v, %v; want an empty table", m, err)
		}
		q, err := db.AppendSide(ctx, "sid_1", "user", "what is this?")
		if err != nil || q.ID == 0 || q.CreatedAt == "" {
			t.Fatalf("AppendSide = %+v, %v", q, err)
		}
		if _, err := db.AppendSide(ctx, "sid_1", "assistant", "a project"); err != nil {
			t.Fatal(err)
		}
		before, _ := db.Agent(ctx, "agt_1")
		if _, err := db.RecordUsage(ctx, UsageRecord{AgentID: "agt_1", Model: "f", Source: SourceAPI, InputTokens: 9, Role: RoleSide}); err != nil {
			t.Fatal(err)
		}
		if after, _ := db.Agent(ctx, "agt_1"); after.InputTokens != before.InputTokens {
			t.Fatalf("side usage changed the agent's totals: %d -> %d", before.InputTokens, after.InputTokens)
		}
		log, err := db.UsageLog(ctx)
		if err != nil || len(log) < 3 || log[0].Role != "" || log[len(log)-1].Role != "side" {
			t.Fatalf("usage log roles = %+v, %v", log, err)
		}
		rows, err := db.UsageRows(ctx, "0000", "9999", GroupAgent)
		keys := map[string]bool{}
		for _, r := range rows {
			keys[r.Key+"/"+r.Label] = true
		}
		if err != nil || !keys["agt_1/orchestrator"] || !keys["side/side"] {
			t.Fatalf("agent buckets = %v, %v; want the orchestrator and a side bucket", keys, err)
		}
		if err := db.ClearSide(ctx); err != nil {
			t.Fatal(err)
		}
		if m, _ := db.SideMessages(ctx); len(m) != 0 {
			t.Fatalf("after clear: %+v", m)
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
	check(s2)
}
