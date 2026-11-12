package projectstore

import (
	"context"
	"testing"
)

// A schema-5 database (the one before the reviews: it has the stemmed index,
// error hints and the rest of schema 5, and no review tables) opens under schema
// 6, gets the review tables and keeps everything else.
func TestMigrateFromSchema5AddsReviewTables(t *testing.T) {
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
	if _, err := db.CreateNote(ctx, "keep", "me", "user"); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`DROP TABLE reviews`, `DROP TABLE review_viewed`, `DROP TABLE review_findings`, `DROP TABLE review_comments`,
		`PRAGMA user_version = 5`,
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
		t.Fatalf("schema 5 does not open: %v", err)
	}
	if notes, err := db.Notes(ctx); err != nil || len(notes) != 1 {
		t.Fatalf("notes = %v %v", notes, err)
	}
	r, err := db.CreateReview(ctx, Review{Source: "local:main..x", Kind: "local", Title: "t"})
	if err != nil {
		t.Fatal(err)
	}
	c, err := db.AddComment(ctx, ReviewComment{ReviewID: r.ID, Kind: "general", Body: "b"})
	if err != nil || c.State != CommentPending {
		t.Fatalf("comment = %+v %v", c, err)
	}
	if _, err := db.AddFinding(ctx, ReviewFinding{ReviewID: r.ID, Path: "a", Statement: "s"}); err != nil {
		t.Fatal(err)
	}
	if err := db.SetViewed(ctx, r.ID, "a", "blob1", "head1"); err != nil {
		t.Fatal(err)
	}
	if v, _ := db.Viewed(ctx, r.ID); v["a"].Blob != "blob1" {
		t.Fatalf("viewed = %+v", v)
	}
	if n, _ := db.PendingComments(ctx, r.ID); n != 1 {
		t.Fatalf("pending = %d", n)
	}
	if v, _ := userVersion(ctx, db.sql); v != SchemaVersion {
		t.Fatalf("user_version = %d, want %d", v, SchemaVersion)
	}
	// Idempotent: a second open is a no-op migration.
	_ = s.Close()
	s2, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	if _, err := s2.Get(ctx, pid); err != nil {
		t.Fatal(err)
	}
}

// The whole chain from schema 4: a database from before schema 5 (no stemmed
// index) and before 6 (no review tables) gets both on one open.
func TestMigrateFromSchema4RunsBothStepsToTheReviews(t *testing.T) {
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
	orch, _ := db.Orchestrator(ctx)
	say(t, db, orch.ID, "user", "Нужен калькулятор со скобками")
	for _, q := range []string{
		`DROP TABLE reviews`, `DROP TABLE review_viewed`, `DROP TABLE review_findings`, `DROP TABLE review_comments`,
		`DROP TABLE search_s`, `PRAGMA user_version = 4`,
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
		t.Fatalf("schema 4 does not open: %v", err)
	}
	finds(t, db, "калькуляторами", "калькулятор")
	if _, err := db.CreateReview(ctx, Review{Source: "local:main..x", Kind: "local", Title: "t"}); err != nil {
		t.Fatal(err)
	}
	if v, _ := userVersion(ctx, db.sql); v != SchemaVersion {
		t.Fatalf("user_version = %d, want %d", v, SchemaVersion)
	}
}
