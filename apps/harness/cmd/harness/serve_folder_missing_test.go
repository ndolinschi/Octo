package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// A project folder moved away: the project says so, and a message, a terminal, a Processes run and the file routes
// answer folder_missing naming the folder, not "Something went wrong … fork/exec /bin/bash: no such file or directory".
func TestServeMissingProjectFolder(t *testing.T) {
	emptyEnv(t)
	t.Setenv("PATH", "/usr/bin:/bin")
	dir := t.TempDir()
	folder := filepath.Join(t.TempDir(), "app")
	if err := os.MkdirAll(folder, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg, _, err := serveConfig([]string{"--data-dir", dir})
	if err != nil {
		t.Fatal(err)
	}
	cfg.APIToken = testAPIToken
	base := startServeWith(t, cfg, "127.0.0.1")
	status, body := request(t, "POST", base+"/v1/projects", map[string]any{"name": "p", "folders": []map[string]string{{"label": "app", "path": folder}}})
	if status != 201 {
		t.Fatalf("create = %d %s", status, body)
	}
	var p struct{ ID string }
	_ = json.Unmarshal(body, &p)
	if err := os.Rename(folder, folder+".moved"); err != nil {
		t.Fatal(err)
	}

	status, body = request(t, "GET", base+"/v1/projects/"+p.ID, nil)
	var got struct{ Error *usererr.Info }
	_ = json.Unmarshal(body, &got)
	if status != 200 || got.Error == nil || !strings.Contains(got.Error.Message, "app is missing") || !strings.Contains(got.Error.Details, folder) {
		t.Fatalf("GET project = %d %s", status, body)
	}
	for _, c := range []struct {
		method, path string
		body         any
	}{
		{"POST", "/v1/projects/" + p.ID + "/messages", map[string]any{"text": "hi"}},
		{"POST", "/v1/projects/" + p.ID + "/terminals", map[string]any{}},
		{"POST", "/v1/projects/" + p.ID + "/runs", map[string]any{"command": "true"}},
		{"GET", "/v1/projects/" + p.ID + "/files?folder=app&path=", nil},
	} {
		status, body = request(t, c.method, base+c.path, c.body)
		var eb struct {
			Error struct{ Code, Message, Hint, Details string }
		}
		_ = json.Unmarshal(body, &eb)
		if status != 409 || eb.Error.Code != usererr.CodeFolderMissing || !strings.Contains(eb.Error.Message, "app") ||
			!strings.Contains(eb.Error.Hint, "remove it from the project") || !strings.Contains(eb.Error.Details, folder) {
			t.Errorf("%s %s = %d %s", c.method, c.path, status, body)
		}
	}
}
