package projectstore

import (
	"context"
	"testing"
)

func TestLastReportedContext(t *testing.T) {
	ctx := context.Background()
	db := create(t, newStore(t), "p")
	orch, err := db.Orchestrator(ctx)
	if err != nil {
		t.Fatal(err)
	}
	use := func(r UsageRecord) {
		t.Helper()
		r.AgentID, r.Model, r.Source = orch.ID, "m", SourceAPI
		if _, err := db.RecordUsage(ctx, r); err != nil {
			t.Fatal(err)
		}
	}
	want := func(step string, tokens int64, ok bool) {
		t.Helper()
		got, found, err := db.LastReportedContext(ctx, orch.ID)
		if err != nil || found != ok || got.Tokens != tokens {
			t.Fatalf("%s: got %+v found=%v err=%v, want %d found=%v", step, got, found, err, tokens, ok)
		}
	}

	want("no rows", 0, false)
	use(UsageRecord{InputTokens: 100, CacheReadTokens: 20, CacheWriteTokens: 5, OutputTokens: 9})
	want("input plus cache read and write", 125, true)
	use(UsageRecord{InputTokens: 900, Role: RoleSide})
	want("a side row never counts", 125, true)
	use(UsageRecord{InputTokens: 0, OutputTokens: 0, RouteTrigger: "none"})
	want("an empty row (a 402) never counts", 125, true)
	use(UsageRecord{InputTokens: 700, RouteTrigger: "compact"})
	want("a compaction request is not a context size", 125, true)
	if _, err := db.AddCompaction(ctx, orch.ID, "summary"); err != nil {
		t.Fatal(err)
	}
	want("figures from before a compaction are stale", 0, false)
	use(UsageRecord{InputTokens: 60})
	want("the first response after it counts", 60, true)

	orch2 := create(t, newStore(t), "q")
	o2, _ := orch2.Orchestrator(ctx)
	// A compaction stored before usage_id existed falls back to the clock.
	if _, err := orch2.RecordUsage(ctx, UsageRecord{AgentID: o2.ID, Model: "m", Source: SourceAPI, InputTokens: 11, CreatedAt: "2026-01-01T00:00:00.000Z"}); err != nil {
		t.Fatal(err)
	}
	if _, err := orch2.sql.ExecContext(ctx, `INSERT INTO compactions (agent_id, summary, upto_message_id, created_at) VALUES (?, 's', 0, '2026-01-02T00:00:00.000Z')`, o2.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := orch2.LastReportedContext(ctx, o2.ID); ok || err != nil {
		t.Fatalf("legacy compaction: found=%v err=%v, want stale", ok, err)
	}
	if _, err := orch2.RecordUsage(ctx, UsageRecord{AgentID: o2.ID, Model: "m", Source: SourceAPI, InputTokens: 12, CreatedAt: "2026-01-03T00:00:00.000Z"}); err != nil {
		t.Fatal(err)
	}
	if got, ok, err := orch2.LastReportedContext(ctx, o2.ID); !ok || err != nil || got.Tokens != 12 {
		t.Fatalf("legacy compaction after a new row: %+v ok=%v err=%v", got, ok, err)
	}
}
