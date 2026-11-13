package projectstore

import (
	"context"
	"fmt"
	"testing"
)

// A schema 6 or 7 database (reviews, no threads table, no in_reply_to column) gets
// the review-workflow additions on open and keeps its comments.
func TestMigrateFromSchema6And7AddsThreadsAndReplyColumn(t *testing.T) {
	for _, from := range []int{6, 7} {
		t.Run(fmt.Sprintf("from_%d", from), func(t *testing.T) { migrateReviewWorkflowFrom(t, from) })
	}
}

func migrateReviewWorkflowFrom(t *testing.T, from int) {
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
	r, err := db.CreateReview(ctx, Review{Source: "local:a..b", Kind: "local", Title: "t"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.AddComment(ctx, ReviewComment{ReviewID: r.ID, Kind: "general", Body: "kept"}); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{`DROP TABLE review_threads`, `ALTER TABLE review_comments DROP COLUMN in_reply_to`, fmt.Sprintf(`PRAGMA user_version = %d`, from)} {
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
	cs, err := db.Comments(ctx, r.ID, "")
	if err != nil || len(cs) != 1 || cs[0].Body != "kept" || cs[0].InReplyTo != "" {
		t.Fatalf("comments = %+v %v", cs, err)
	}
	if _, err := db.ReviewThreads(ctx, r.ID); err != ErrNotFound {
		t.Fatalf("threads before any fetch = %v", err)
	}
	if err := db.SetReviewThreads(ctx, r.ID, ReviewThreadsRow{JSON: `[{"id":"T1"}]`, FetchedAt: "now"}); err != nil {
		t.Fatal(err)
	}
	if err := db.SetReviewThreadsError(ctx, r.ID, "boom"); err != nil {
		t.Fatal(err)
	}
	row, err := db.ReviewThreads(ctx, r.ID)
	if err != nil || row.JSON != `[{"id":"T1"}]` || row.Error != "boom" || row.FetchedAt != "now" {
		t.Fatalf("threads = %+v %v", row, err)
	}
	if v, _ := userVersion(ctx, db.sql); v != SchemaVersion {
		t.Fatalf("user_version = %d, want %d", v, SchemaVersion)
	}
}
