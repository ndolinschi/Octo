package projectstore

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

func say(t *testing.T, db *DB, agentID, role, text string) {
	t.Helper()
	b, _ := json.Marshal([]map[string]any{{"type": "text", "text": text}})
	if _, err := db.AppendMessage(context.Background(), agentID, role, b); err != nil {
		t.Fatal(err)
	}
}

func finds(t *testing.T, db *DB, query, want string) {
	t.Helper()
	hits, err := db.Search(context.Background(), SearchQuery{Text: query})
	if err != nil {
		t.Fatal(err)
	}
	for _, h := range hits {
		if containsFold(h.Body, want) {
			return
		}
	}
	t.Errorf("search %q found %d hits, none with %q", query, len(hits), want)
}

func containsFold(s, sub string) bool { return strings.Contains(FoldRU(s), FoldRU(sub)) }

var russianCorpus = []string{
	"Нужен калькулятор с поддержкой скобок и степеней",
	"Столица Молдовы — Кишинёв, там живёт заказчик",
	"Бюджет проекта нужно уложить в тысячу долларов",
}

func TestRussianWordFormsFindEachOther(t *testing.T) {
	s := newStore(t)
	db := create(t, s, "ru")
	orch, _ := db.Orchestrator(context.Background())
	for _, text := range russianCorpus {
		say(t, db, orch.ID, "user", text)
	}
	for q, want := range map[string]string{
		"калькуляторами": "калькулятор",
		"скобками":       "скобок",
		"молдове":        "Молдовы",
		"Кишинев":        "Кишинёв",
		"бюджетом":       "Бюджет",
	} {
		t.Run(q, func(t *testing.T) { finds(t, db, q, want) })
	}
	// What is not there is still not found.
	if hits, err := db.Search(context.Background(), SearchQuery{Text: "вертолётами"}); err != nil || len(hits) != 0 {
		t.Fatalf("hits for an absent word: %v %v", hits, err)
	}
}

// A database from before the stemmed index (schema 4) is indexed when it is opened.
func TestStemmedIndexIsBuiltWhenAnOlderDatabaseOpens(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	db, err := s.Create(ctx, NewProject{Name: "old", Description: "d", ModelsJSON: `{}`, MaxDepth: 3})
	if err != nil {
		t.Fatal(err)
	}
	orch, _ := db.Orchestrator(ctx)
	for _, text := range russianCorpus {
		say(t, db, orch.ID, "user", text)
	}
	id := db.ID()
	_ = s.Close()

	// Make it look like schema 4: no stemmed index, stamp 4.
	path := filepath.Join(dir, "projects", id, "project.sqlite")
	raw, err := openSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{`DROP TABLE search_s`, `PRAGMA user_version = 4`} {
		if _, err := raw.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	_ = raw.Close()

	s2, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	db2, err := s2.Get(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	finds(t, db2, "калькуляторами", "калькулятор")
	finds(t, db2, "Кишинев", "Кишинёв")
	if v, err := userVersion(ctx, db2.sql); err != nil || v != SchemaVersion {
		t.Fatalf("user_version = %d %v", v, err)
	}
}
