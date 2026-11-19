package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// makeProjects writes n projects into a fresh data folder and closes the store.
func makeProjects(t *testing.T, dir string, names ...string) []string {
	t.Helper()
	st, err := projectstore.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, n := range names {
		db, err := st.Create(context.Background(), projectstore.NewProject{Name: n, ModelsJSON: "{}", MaxDepth: 2, OrchestratorModel: "m"})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, db.ID())
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	return ids
}

func projectFile(dir, id string) string { return filepath.Join(dir, "projects", id, "project.sqlite") }

// One project whose database is random bytes, one truncated, one written by a newer schema: the harness starts,
// lists the good project as usual and the three as unavailable with the catalogue case (the file in details), and
// a request to one of them answers that case. No file is changed.
func TestServeStartsWithUnavailableProjects(t *testing.T) {
	emptyEnv(t)
	dir := t.TempDir()
	ids := makeProjects(t, dir, "good", "garbage", "truncated", "newer")
	good, garbage, truncated, newer := ids[0], ids[1], ids[2], ids[3]

	junk := make([]byte, 64<<10)
	_, _ = rand.Read(junk)
	if err := os.WriteFile(projectFile(dir, garbage), junk, 0o600); err != nil {
		t.Fatal(err)
	}
	backup := projectFile(dir, garbage) + projectstore.BackupSuffix
	if err := os.WriteFile(backup, []byte("old copy"), 0o600); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(projectFile(dir, truncated))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(projectFile(dir, truncated), raw[:len(raw)/2], 0o600); err != nil {
		t.Fatal(err)
	}
	ndb, err := sql.Open("sqlite", projectFile(dir, newer))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ndb.Exec(`PRAGMA user_version = 99`); err != nil {
		t.Fatal(err)
	}
	_ = ndb.Close()
	before := map[string][]byte{}
	for _, id := range ids[1:] {
		before[id], _ = os.ReadFile(projectFile(dir, id))
	}

	cfg, _, err := serveConfig([]string{"--data-dir", dir})
	if err != nil {
		t.Fatal(err)
	}
	cfg.APIToken = testAPIToken
	base := startServeWith(t, cfg, "127.0.0.1")

	status, body := request(t, "GET", base+"/v1/projects", nil)
	if status != 200 {
		t.Fatalf("GET /v1/projects = %d %s", status, body)
	}
	var resp struct {
		Projects []struct {
			ID, Name, Status string
			Error            *usererr.Info
		}
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatal(err)
	}
	list := resp.Projects
	byID := map[string]int{}
	for i, p := range list {
		byID[p.ID] = i
	}
	if len(list) != 4 {
		t.Fatalf("listed %d projects, want 4: %s", len(list), body)
	}
	if p := list[byID[good]]; p.Status != "idle" || p.Error != nil {
		t.Fatalf("good project = %+v", p)
	}
	for _, id := range []string{garbage, truncated, newer} {
		p := list[byID[id]]
		if p.Status != "unavailable" || p.Error == nil || !strings.Contains(p.Error.Details, projectFile(dir, id)) || p.Name == "" {
			t.Fatalf("project %s = %+v, want unavailable with its file in details", id, p)
		}
	}
	if e := list[byID[garbage]].Error; !strings.Contains(e.Message, "damaged") || !strings.Contains(e.Hint, "copy made before an update") || !strings.Contains(e.Details, backup) {
		t.Fatalf("garbage error = %+v", e)
	}
	if e := list[byID[newer]].Error; !strings.Contains(e.Message, "newer version") || !strings.Contains(e.Hint, "Update Octo") {
		t.Fatalf("newer error = %+v", e)
	}

	for _, route := range []struct{ method, path string }{{"GET", "/v1/projects/" + garbage}, {"POST", "/v1/projects/" + truncated + "/messages"}} {
		status, body = request(t, route.method, base+route.path, map[string]any{"text": "hi"})
		var eb struct {
			Error struct{ Code, Message, Details string }
		}
		_ = json.Unmarshal(body, &eb)
		if status != 409 || eb.Error.Code != usererr.CodeProjectUnavailable || !strings.Contains(eb.Error.Details, "project.sqlite") {
			t.Fatalf("%s %s = %d %s", route.method, route.path, status, body)
		}
	}
	status, body = request(t, "GET", base+"/v1/projects/"+newer, nil)
	if status != 409 || !strings.Contains(string(body), usererr.CodeNewerSchema) {
		t.Fatalf("GET newer = %d %s", status, body)
	}
	for id, b := range before {
		now, _ := os.ReadFile(projectFile(dir, id))
		if string(now) != string(b) {
			t.Fatalf("the file of %s was changed", id)
		}
	}
	if _, err := os.Stat(backup); err != nil {
		t.Fatalf("backup: %v", err)
	}
	// Removing an unavailable project from Octo works (it deletes Octo's own copy only).
	if status, body = request(t, "DELETE", base+"/v1/projects/"+garbage, nil); status/100 != 2 {
		t.Fatalf("DELETE garbage = %d %s", status, body)
	}
}

// A damaged registry stops the harness with the catalogue case naming the file, and no other error.
func TestServeStopsOnDamagedRegistry(t *testing.T) {
	emptyEnv(t)
	dir := t.TempDir()
	makeProjects(t, dir, "a")
	reg := filepath.Join(dir, "registry.sqlite")
	junk := make([]byte, 16<<10)
	_, _ = rand.Read(junk)
	if err := os.WriteFile(reg, junk, 0o600); err != nil {
		t.Fatal(err)
	}
	err := startOnce(t, dir)
	var u *usererr.Error
	if !errors.As(err, &u) || u.Code != usererr.CodeRegistryUnavailable || !strings.Contains(err.Error(), reg) ||
		!strings.Contains(err.Error(), "Octo cannot open its list of projects.") {
		t.Fatalf("serve on a damaged registry = %v", err)
	}
	if b, _ := os.ReadFile(reg); string(b) != string(junk) {
		t.Fatal("the registry was changed")
	}
}
