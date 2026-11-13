package projectstore

import (
	"context"
	"testing"
)

// A schema-8 database (no command on messages, no clear columns on compactions) opens under
// schema 9, keeps its rows, and takes a clear and a command message.
func TestMigrateFromSchema8AddsCommandAndClear(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	db, err := s.Create(ctx, NewProject{Name: "p", ModelsJSON: "{}", MaxDepth: 1, OrchestratorModel: "m"})
	if err != nil {
		t.Fatal(err)
	}
	pid := db.ID()
	orch, err := db.Orchestrator(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.AppendMessage(ctx, orch.ID, "user", []byte(`[{"type":"text","text":"before the migration"}]`)); err != nil {
		t.Fatal(err)
	}
	if _, err := db.AddManualCompaction(ctx, orch.ID, "old summary", 1); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`ALTER TABLE messages DROP COLUMN command`, `ALTER TABLE compactions DROP COLUMN cleared`,
		`ALTER TABLE compactions DROP COLUMN conversation_id`, `ALTER TABLE compactions DROP COLUMN summary_source`,
		`ALTER TABLE compactions DROP COLUMN title`, `PRAGMA user_version = 8`,
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
		t.Fatalf("schema 8 does not open: %v", err)
	}
	msgs, err := db.Messages(ctx, orch.ID)
	if err != nil || len(msgs) != 1 || msgs[0].Command != "" {
		t.Fatalf("messages = %+v %v", msgs, err)
	}
	if comps, err := db.Compactions(ctx, orch.ID); err != nil || len(comps) != 1 || comps[0].Summary != "old summary" || comps[0].Cleared {
		t.Fatalf("compactions = %+v %v", comps, err)
	}
	cmd, err := db.AppendMessageCommand(ctx, orch.ID, "user", []byte(`[{"type":"text","text":"/init"}]`), "init")
	if err != nil || cmd.Command != "init" {
		t.Fatalf("command message = %+v %v", cmd, err)
	}
	c, err := db.AddClear(ctx, orch.ID, "conv_1", "carry", "stored", "title")
	if err != nil || !c.Cleared || c.UptoMessageID != cmd.ID {
		t.Fatalf("clear = %+v %v", c, err)
	}
	after, _ := db.AppendMessage(ctx, orch.ID, "user", []byte(`[{"type":"text","text":"after"}]`))
	live, err := db.LiveMessages(ctx, orch.ID)
	if err != nil || len(live) != 1 || live[0].ID != after.ID {
		t.Fatalf("live = %+v %v", live, err)
	}
	if all, _ := db.Messages(ctx, orch.ID); len(all) != 3 || all[1].Command != "init" {
		t.Fatalf("every message stays: %+v", all)
	}
	if cl, _ := db.Clears(ctx, orch.ID); len(cl) != 1 || cl[0].Title != "title" || cl[0].SummarySource != "stored" || cl[0].Summary != "carry" {
		t.Fatalf("clears = %+v", cl)
	}
	if comps, _ := db.Compactions(ctx, orch.ID); len(comps) != 1 {
		t.Fatalf("a clear is not listed as a compaction: %+v", comps)
	}
	if v, _ := userVersion(ctx, db.sql); v != SchemaVersion {
		t.Fatalf("user_version = %d, SchemaVersion = %d", v, SchemaVersion)
	}
}
