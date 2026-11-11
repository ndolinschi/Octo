package projectstore

import (
	"context"
	"os"
	"testing"
)

// phaseAUsage is the usage table as the Phase A release created it, before the
// router columns, plus a project table without budget_usd.
const phaseAUsage = `
CREATE TABLE usage (
	id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, model TEXT NOT NULL, source TEXT NOT NULL,
	input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
	cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
	cost_usd REAL, created_at TEXT NOT NULL
);
CREATE INDEX usage_created ON usage (created_at);`

func TestMigrateAddsRouterColumns(t *testing.T) {
	ctx := context.Background()
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	const id = "prj_phasea"
	if err := os.MkdirAll(s.projectDir(id), 0o755); err != nil {
		t.Fatal(err)
	}
	old, err := openSQLite(s.projectDir(id) + "/project.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		preUsageSchema, phaseAUsage,
		`ALTER TABLE agents ADD COLUMN context_used INTEGER`, `ALTER TABLE agents ADD COLUMN context_size INTEGER`,
		`INSERT INTO project VALUES (1, 'phase a', '', '', '{"orchestrator":"o","fast":"f","balanced":"b","deep":"d"}', 3, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		`INSERT INTO agents (id, depth, role, title, task, model, status, input_tokens, output_tokens, created_at)
		 VALUES ('agt_1', 0, 'orchestrator', '', '', 'm', 'idle', 70, 30, '2026-01-01T00:00:00.000Z')`,
		`INSERT INTO usage (agent_id, model, source, input_tokens, output_tokens, cost_usd, created_at)
		 VALUES ('agt_1', 'm', 'api', 70, 30, 0.5, '2026-01-01T00:00:00.000Z')`,
	} {
		if _, err := old.Exec(q); err != nil {
			t.Fatalf("seed %.40q: %v", q, err)
		}
	}
	if err := old.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.reg.Exec(`INSERT INTO projects VALUES (?, 'phase a', '2026-01-01T00:00:00.000Z')`, id); err != nil {
		t.Fatal(err)
	}
	db, err := s.Get(ctx, id)
	if err != nil {
		t.Fatalf("open Phase A database: %v", err)
	}
	if info, err := db.Info(ctx); err != nil || info.BudgetUSD != nil {
		t.Fatalf("info = %+v, %v; want no budget", info, err)
	}
	log, err := db.UsageLog(ctx)
	if err != nil || len(log) != 1 || log[0].ServedModel != "" || log[0].CostEstimated || log[0].CostUSD == nil || *log[0].CostUSD != 0.5 {
		t.Fatalf("old row after migration = %+v, %v", log, err)
	}
	budget := 2.5
	if err := db.UpdateInfo(ctx, InfoPatch{SetBudget: true, BudgetUSD: &budget}); err != nil {
		t.Fatal(err)
	}
	cost := 0.25
	if _, err := db.RecordUsage(ctx, UsageRecord{
		AgentID: "agt_1", Model: "m", Source: SourceAPI, InputTokens: 5, CostUSD: &cost, CostEstimated: true,
		ServedModel: "served", Tier: "low", RouteTrigger: "hint", RouterRequestID: "octo_1",
	}); err != nil {
		t.Fatal(err)
	}
	rows, err := db.UsageRows(ctx, "0000", "9999", GroupModel)
	if err != nil || len(rows) != 2 {
		t.Fatalf("model rows = %+v, %v; want the old model and the served one", rows, err)
	}
	for _, r := range rows {
		if (r.Model == "served") != r.ReportedEstimated {
			t.Fatalf("row %+v: estimated flag must follow the new row only", r)
		}
	}
	info, _ := db.Info(ctx)
	if info.BudgetUSD == nil || *info.BudgetUSD != 2.5 {
		t.Fatalf("budget = %v", info.BudgetUSD)
	}
	if err := db.UpdateInfo(ctx, InfoPatch{SetBudget: true}); err != nil {
		t.Fatal(err)
	}
	if info, _ := db.Info(ctx); info.BudgetUSD != nil {
		t.Fatalf("budget not cleared: %v", info.BudgetUSD)
	}
}

func TestCompactionStore(t *testing.T) {
	ctx := context.Background()
	db := create(t, newStore(t), "p")
	orch, err := db.Orchestrator(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok, err := db.LatestCompaction(ctx, orch.ID); ok || err != nil {
		t.Fatalf("fresh agent has compaction: %v %v", ok, err)
	}
	m1, _ := db.AppendMessage(ctx, orch.ID, "user", []byte(`[]`))
	if _, err := db.AddCompaction(ctx, orch.ID, "first"); err != nil {
		t.Fatal(err)
	}
	m2, _ := db.AppendMessage(ctx, orch.ID, "user", []byte(`[]`))
	if _, err := db.AddCompaction(ctx, orch.ID, "second"); err != nil {
		t.Fatal(err)
	}
	c, ok, err := db.LatestCompaction(ctx, orch.ID)
	if err != nil || !ok || c.Summary != "second" || c.UptoMessageID != m2.ID || m2.ID <= m1.ID {
		t.Fatalf("latest = %+v ok=%v err=%v", c, ok, err)
	}
}
