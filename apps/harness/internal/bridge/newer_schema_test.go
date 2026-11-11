package bridge_test

import (
	"database/sql"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

// A project database written by a newer version of the app is refused with a
// clear 409 and the store's message on every project route, not a bare 500.
func TestNewerProjectDatabaseAnswers409WithTheMessage(t *testing.T) {
	e, dataDir := newEnvWithData(t)
	pid, _ := e.v7Project(t, "full")
	// Another process (a newer app) stamps the database; this harness reopens it.
	e.closeProject(pid)
	raw, err := sql.Open("sqlite", filepath.Join(dataDir, "projects", pid, "project.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`PRAGMA user_version = 99`); err != nil {
		t.Fatal(err)
	}
	_ = raw.Close()
	for _, c := range []struct{ method, path string }{
		{"GET", "/v1/projects/" + pid},
		{"GET", "/v1/projects/" + pid + "/agents"},
		{"GET", "/v1/projects/" + pid + "/changes"},
		{"GET", "/v1/projects/" + pid + "/tasks"},
		{"GET", "/v1/projects/" + pid + "/files?folder=x&path="},
		{"POST", "/v1/projects/" + pid + "/messages"},
	} {
		var body any
		if c.method == "POST" {
			body = map[string]string{"text": "hello"}
		}
		status, raw := e.do(t, c.method, c.path, body)
		if status != http.StatusConflict || !strings.Contains(string(raw), `"newer_schema"`) || !strings.Contains(string(raw), "newer version of the app") ||
			!strings.Contains(string(raw), "update the app") {
			t.Errorf("%s %s = %d %s", c.method, c.path, status, raw)
		}
	}
}
