package bridge_test

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/apitoken"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools/local"
)

// The file API must not serve the API token file, also when a project folder
// is the data directory's parent (or the data directory itself).
func TestFileAPIRefusesTheDataDirectory(t *testing.T) {
	e := newEnv(t, nil)
	root := t.TempDir()
	data := filepath.Join(root, "harness-data")
	tok, _, err := apitoken.Resolve(data, "")
	if err != nil {
		t.Fatal(err)
	}
	local.ProtectDir(data)
	if err := os.WriteFile(filepath.Join(root, "readme.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(data, filepath.Join(root, "alias")); err != nil {
		t.Fatal(err)
	}

	var p project.Project
	e.into(t, "POST", "/v1/projects", map[string]any{"name": "root", "folders": []map[string]string{{"path": root}}}, http.StatusCreated, &p)
	label := p.Folders[0].Label

	for _, path := range []string{"harness-data/api-token", "alias/api-token", "harness-data/../harness-data/api-token", "../" + filepath.Base(root) + "/harness-data/api-token"} {
		status, body := e.do(t, "GET", filesURL(p.ID, "/content", label, path), nil)
		if status < 400 || status >= 500 || strings.Contains(string(body), tok) {
			t.Errorf("read %q = %d %s", path, status, body)
		}
	}
	for _, path := range []string{"harness-data", "alias"} {
		if status, body := e.do(t, "GET", filesURL(p.ID, "", label, path), nil); status != http.StatusBadRequest {
			t.Errorf("list %q = %d %s, want 400", path, status, body)
		}
	}
	status, body := e.do(t, "PUT", "/v1/projects/"+p.ID+"/files/content", map[string]any{"folder": label, "path": "harness-data/api-token", "content": "x"})
	if status != http.StatusBadRequest {
		t.Errorf("write into the data directory = %d %s", status, body)
	}
	if raw, _ := os.ReadFile(apitoken.Path(data)); !strings.Contains(string(raw), tok) {
		t.Fatalf("the token file was changed through the file API")
	}
	if status, body := e.do(t, "GET", filesURL(p.ID, "/content", label, "readme.txt"), nil); status != http.StatusOK {
		t.Errorf("an ordinary file = %d %s", status, body)
	}
}
