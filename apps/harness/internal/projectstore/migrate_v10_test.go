package projectstore

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

// A schema 8 or 9 database has notes with a title and a body only: opening it adds
// the front-matter columns, derives each description from the body (flagged
// automatic), gives an untitled note its first line as title, indexes the
// notes for search_notes, and keeps the bodies.
func TestMigrateToSchema10GivesNotesDescriptions(t *testing.T) {
	for _, from := range []int{8, 9} {
		t.Run(fmt.Sprintf("from_%d", from), func(t *testing.T) { migrateNotesFrom(t, from) })
	}
}

func migrateNotesFrom(t *testing.T, from int) {
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
	long := strings.Repeat("x", 300)
	old := []struct{ id, title, body string }{
		{"n1", "Goal", "\n\n  Ship the beta by Friday  \nSecond line"},
		{"n2", "", "First line becomes the title\nrest"},
		{"n3", "Long", long},
		{"n4", "Empty", ""},
		{"n5", "Бюджет", "Лимит бюджета на месяц: 500 долларов"},
	}
	for _, q := range []string{`DELETE FROM notes`,
		`ALTER TABLE notes DROP COLUMN description`, `ALTER TABLE notes DROP COLUMN description_auto`,
		`ALTER TABLE notes DROP COLUMN tags_json`, `ALTER TABLE notes DROP COLUMN pinned`,
		`ALTER TABLE notes DROP COLUMN last_read_at`, `ALTER TABLE notes DROP COLUMN read_count`} {
		if err := db.Exec_(ctx, q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	for _, o := range old {
		if err := db.Exec_(ctx, `INSERT INTO notes (id, title, content, author, created_at, updated_at) VALUES (?, ?, ?, 'user', ?, ?)`,
			o.id, o.title, o.body, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Exec_(ctx, fmt.Sprintf(`PRAGMA user_version = %d`, from)); err != nil {
		t.Fatal(err)
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
	if v, _ := userVersion(ctx, db.sql); v != SchemaVersion {
		t.Fatalf("user_version = %d, want %d", v, SchemaVersion)
	}
	want := map[string]struct{ title, desc, body string }{
		"n1": {"Goal", "Ship the beta by Friday", old[0].body},
		"n2": {"First line becomes the title", "First line becomes the title", old[1].body},
		"n3": {"Long", strings.Repeat("x", 200), long},
		"n4": {"Empty", "", ""},
		"n5": {"Бюджет", "Лимит бюджета на месяц: 500 долларов", old[4].body},
	}
	notes, err := db.Notes(ctx)
	if err != nil || len(notes) != len(want) {
		t.Fatalf("notes = %d, %v", len(notes), err)
	}
	for _, n := range notes {
		w := want[n.ID]
		if n.Title != w.title || n.Description != w.desc || !n.DescriptionAuto || n.Content != w.body || n.Pinned || n.ReadCount != 0 || n.LastReadAt != "" || n.Tags == nil || len(n.Tags) != 0 {
			t.Errorf("%s = %+v, want %+v", n.ID, n, w)
		}
	}
	// Indexed for search, Russian inflection included; the memory search does not see notes.
	hits, err := db.SearchNotes(ctx, "бюджет", 5)
	if err != nil || len(hits) != 1 || hits[0].ID != "n5" {
		t.Fatalf("search = %+v, %v", hits, err)
	}
	if mh, err := db.Search(ctx, SearchQuery{Text: "бюджет"}); err != nil || len(mh) != 0 {
		t.Fatalf("memory search returned notes: %+v, %v", mh, err)
	}
	// Opening again changes nothing.
	_ = s.Close()
	s, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	db, _ = s.Get(ctx, pid)
	if again, _ := db.Notes(ctx); len(again) != 5 || again[0].Description != "Ship the beta by Friday" {
		t.Fatalf("second open: %+v", again)
	}
}

func TestNoteDescriptionFollowsTheBodyUntilWritten(t *testing.T) {
	ctx := context.Background()
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	db, err := s.Create(ctx, NewProject{Name: "p", ModelsJSON: "{}", MaxDepth: 1, OrchestratorModel: "m"})
	if err != nil {
		t.Fatal(err)
	}
	n, err := db.CreateNote(ctx, "T", "first\nsecond", AuthorUser)
	if err != nil || n.Description != "first" || !n.DescriptionAuto {
		t.Fatalf("%+v %v", n, err)
	}
	body := "other\nlines"
	n, err = db.PatchNote(ctx, n.ID, NotePatch{Body: &body})
	if err != nil || n.Description != "other" || !n.DescriptionAuto {
		t.Fatalf("auto follows the body: %+v %v", n, err)
	}
	desc := "Written by hand"
	n, err = db.PatchNote(ctx, n.ID, NotePatch{Description: &desc})
	if err != nil || n.Description != desc || n.DescriptionAuto {
		t.Fatalf("%+v %v", n, err)
	}
	body = "third"
	if n, _ = db.PatchNote(ctx, n.ID, NotePatch{Body: &body}); n.Description != desc || n.DescriptionAuto {
		t.Fatalf("a written description stays: %+v", n)
	}
	n, err = db.ReadNote(ctx, n.ID)
	if err != nil || n.ReadCount != 1 || n.LastReadAt == "" {
		t.Fatalf("%+v %v", n, err)
	}
	if err := db.DeleteNote(ctx, n.ID); err != nil {
		t.Fatal(err)
	}
	if hits, _ := db.SearchNotes(ctx, "third", 5); len(hits) != 0 {
		t.Fatalf("a deleted note is still found: %+v", hits)
	}
	if _, err := db.ReadNote(ctx, n.ID); err != ErrNotFound {
		t.Fatalf("%v", err)
	}
}
