package projectstore

import (
	"context"
	"testing"
)

// A schema-6 database (no approval rules, no network settings) opens under
// schema 7, keeps its rows, defaults to network off, and takes rules.
func TestMigrateFromSchema6AddsApprovalRulesAndNetwork(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	db, err := s.Create(ctx, NewProject{Name: "p", ModelsJSON: "{}", MaxDepth: 1, OrchestratorModel: "m", Network: NetworkOn, NetworkPrivate: true})
	if err != nil {
		t.Fatal(err)
	}
	pid := db.ID()
	if _, err := db.CreateNote(ctx, "keep", "me", "user"); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`DROP TABLE approval_rules`, `DROP TABLE plans`, `ALTER TABLE project DROP COLUMN network`, `ALTER TABLE project DROP COLUMN network_private`,
		`ALTER TABLE project DROP COLUMN mode`, `ALTER TABLE messages DROP COLUMN rewound_at`, `ALTER TABLE agents DROP COLUMN rewound_at`,
		`ALTER TABLE queue DROP COLUMN mode`, `ALTER TABLE compactions DROP COLUMN manual`, `ALTER TABLE compactions DROP COLUMN message_count`,
		`PRAGMA user_version = 6`,
	} {
		if err := db.Exec_(ctx, q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	_ = s.Close()

	s, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	db, err = s.Get(ctx, pid)
	if err != nil {
		t.Fatalf("schema 6 does not open: %v", err)
	}
	if notes, err := db.Notes(ctx); err != nil || len(notes) != 1 {
		t.Fatalf("notes = %v %v", notes, err)
	}
	info, err := db.Info(ctx)
	if err != nil || info.Network != NetworkOff || info.NetworkPrivate {
		t.Fatalf("info = %+v %v: an older project has the network off", info, err)
	}
	on, priv := NetworkOn, true
	if err := db.UpdateInfo(ctx, InfoPatch{Network: &on, NetworkPrivate: &priv}); err != nil {
		t.Fatal(err)
	}
	if info, _ = db.Info(ctx); info.Network != NetworkOn || !info.NetworkPrivate {
		t.Fatalf("info = %+v", info)
	}
	if info.Mode != ModeAgent {
		t.Fatalf("mode = %q: an older project runs in agent mode", info.Mode)
	}
	if _, err := db.AddPlan(ctx, 1, "step one"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.EnqueueMode(ctx, "q", "plan"); err != nil {
		t.Fatal(err)
	}
	r1, err := db.AddApprovalRule(ctx, "bash", "pnpm test", false)
	if err != nil {
		t.Fatal(err)
	}
	r2, err := db.AddApprovalRule(ctx, "bash", "pnpm test", false)
	if err != nil || r2.ID != r1.ID {
		t.Fatalf("an identical rule is saved once: %+v %+v %v", r1, r2, err)
	}
	if _, err := db.AddApprovalRule(ctx, "bash", "pnpm test", true); err != nil {
		t.Fatal(err)
	}
	list, err := db.ApprovalRules(ctx)
	if err != nil || len(list) != 2 {
		t.Fatalf("rules = %+v %v", list, err)
	}
	if err := db.DeleteApprovalRule(ctx, r1.ID); err != nil {
		t.Fatal(err)
	}
	if err := db.DeleteApprovalRule(ctx, r1.ID); err != ErrNotFound {
		t.Fatalf("second delete = %v", err)
	}
	if v, _ := userVersion(ctx, db.sql); v != SchemaVersion || SchemaVersion != 7 {
		t.Fatalf("user_version = %d, SchemaVersion = %d", v, SchemaVersion)
	}
}
