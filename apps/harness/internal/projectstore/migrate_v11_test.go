package projectstore

import (
	"context"
	"fmt"
	"testing"
)

// A database stamped 8, 9 or 10 (no attachments table, no queue.attachments column) opens,
// keeps its queue, and then stores attachments and queued images.
func TestMigrateToSchema11AddsAttachments(t *testing.T) {
	for _, from := range []int{8, 9, 10} {
		t.Run(fmt.Sprintf("from_%d", from), func(t *testing.T) { migrateAttachmentsFrom(t, from) })
	}
}

func migrateAttachmentsFrom(t *testing.T, from int) {
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
	if _, err := db.Enqueue(ctx, "kept"); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{`DROP TABLE attachments`, `ALTER TABLE queue DROP COLUMN attachments`, fmt.Sprintf(`PRAGMA user_version = %d`, from)} {
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
		t.Fatalf("schema %d does not open: %v", from, err)
	}
	q, _, err := db.Queue(ctx)
	if err != nil || len(q) != 1 || q[0].Text != "kept" || len(q[0].Attachments) != 0 {
		t.Fatalf("queue = %+v %v", q, err)
	}
	m, err := db.EnqueueWith(ctx, "with image", "", []string{"att_aaaaaaaaaaaaaaaaaaaaaaaa"})
	if err != nil {
		t.Fatal(err)
	}
	q, _, _ = db.Queue(ctx)
	if len(q) != 2 || len(q[1].Attachments) != 1 || q[1].ID != m.ID {
		t.Fatalf("queue after = %+v", q)
	}
	if _, err := db.Attachment(ctx, "att_bbbbbbbbbbbbbbbbbbbbbbbb"); err != ErrNotFound {
		t.Fatalf("unknown attachment = %v", err)
	}
	if v, _ := userVersion(ctx, db.sql); v != SchemaVersion {
		t.Fatalf("user_version = %d, want %d", v, SchemaVersion)
	}
}
