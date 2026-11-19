package bridge_test

import (
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
)

type fileStat struct {
	Folder, Path, MTime string
	Size                int64
}

func newFileProject(t *testing.T, e *env) (pid, label, dir string) {
	t.Helper()
	dir = t.TempDir()
	outside := t.TempDir()
	for name, content := range map[string]string{"a.txt": "alpha", "src/main.go": "package main\n"} {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(dir, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "bin.dat"), []byte{0, 1, 2}, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "big.txt"), []byte(strings.Repeat("x", 2<<20+1)), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "out")); err != nil {
		t.Fatal(err)
	}
	var p project.Project
	e.into(t, "POST", "/v1/projects", map[string]any{"name": "F", "folders": []map[string]string{{"path": dir}}}, http.StatusCreated, &p)
	return p.ID, p.Folders[0].Label, dir
}

func filesURL(pid, kind, folder, path string) string {
	q := url.Values{"folder": {folder}, "path": {path}}
	return "/v1/projects/" + pid + "/files" + kind + "?" + q.Encode()
}

func TestFileEndpoints(t *testing.T) {
	e := newEnv(t, nil)
	pid, label, dir := newFileProject(t, e)
	stream := e.subscribe(t, pid)

	var list struct {
		Entries []struct{ Name, Path, Type string }
	}
	e.into(t, "GET", filesURL(pid, "", label, ""), nil, http.StatusOK, &list)
	var got []string
	for _, en := range list.Entries {
		got = append(got, en.Type+":"+en.Path)
	}
	if want := "dir:out,dir:src,file:a.txt,file:big.txt,file:bin.dat"; strings.Join(got, ",") != want {
		t.Fatalf("entries = %v", got)
	}

	var rd struct {
		fileStat
		Content string
	}
	e.into(t, "GET", filesURL(pid, "/content", label, "src/main.go"), nil, http.StatusOK, &rd)
	if rd.Content != "package main\n" || rd.Folder != label || rd.Path != "src/main.go" || rd.Size != 13 {
		t.Fatalf("read = %+v", rd)
	}
	if _, err := time.Parse(time.RFC3339Nano, rd.MTime); err != nil || !strings.HasSuffix(rd.MTime, "Z") {
		t.Fatalf("mtime = %q (%v)", rd.MTime, err)
	}

	put := func(content string, expected *string, status int) fileStat {
		body := map[string]any{"folder": label, "path": "src/main.go", "content": content}
		if expected != nil {
			body["expected_mtime"] = *expected
		}
		var st fileStat
		e.into(t, "PUT", "/v1/projects/"+pid+"/files/content", body, status, &st)
		return st
	}
	st := put("package main // v2\n", &rd.MTime, http.StatusOK)
	if st.Path != "src/main.go" || st.Folder != label || st.Size != 19 || st.MTime == "" {
		t.Fatalf("put stat = %+v", st)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "src/main.go")); string(b) != "package main // v2\n" {
		t.Fatalf("disk = %q", b)
	}
	stale := "2000-01-01T00:00:00Z"
	e.wantError(t, "PUT", "/v1/projects/"+pid+"/files/content",
		map[string]any{"folder": label, "path": "src/main.go", "content": "x", "expected_mtime": stale}, http.StatusConflict, "file_changed")
	e.wantError(t, "PUT", "/v1/projects/"+pid+"/files/content",
		map[string]any{"folder": label, "path": "ghost.txt", "content": "x", "expected_mtime": st.MTime}, http.StatusConflict, "file_changed")
	e.wantError(t, "PUT", "/v1/projects/"+pid+"/files/content",
		map[string]any{"folder": label, "path": "nodir/x.txt", "content": "x"}, http.StatusNotFound, "not_found")
	e.wantError(t, "PUT", "/v1/projects/"+pid+"/files/content",
		map[string]any{"folder": label, "path": "../x.txt", "content": "x"}, http.StatusBadRequest, "invalid_request")
	e.wantError(t, "PUT", "/v1/projects/"+pid+"/files/content",
		map[string]any{"folder": label, "path": "n.txt", "content": strings.Repeat("y", 3<<20)}, http.StatusRequestEntityTooLarge, "file_too_large")

	select {
	case ev := <-stream:
		if ev.Type != events.FileChanged || ev.Data["folder"] != label || ev.Data["path"] != "src/main.go" || ev.Data["source"] != "user" {
			t.Fatalf("event = %+v", ev)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no file.changed event after PUT")
	}
}

// The reviewer's proof: PUT .git/config with core.fsmonitor made a later worktree creation run the command. The file
// API refuses every path under .git (any case, through a symlink, the .git file of a worktree) with a structured
// error and leaves the file alone; reading it still works (security review finding 3a).
func TestFileWriteRefusesGitDir(t *testing.T) {
	e := newEnv(t, nil)
	pid, label, dir := newFileProject(t, e)
	if err := os.WriteFile(filepath.Join(dir, ".git/config"), []byte("[core]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(".git", filepath.Join(dir, "g")); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{".git/config", ".GIT/config", "g/config", "src/../.git/hooks/post-checkout"} {
		var resp struct {
			Error struct{ Code, Message, Hint string } `json:"error"`
		}
		e.into(t, "PUT", "/v1/projects/"+pid+"/files/content",
			map[string]any{"folder": label, "path": p, "content": "[core]\n\tfsmonitor = touch pwned\n"}, http.StatusBadRequest, &resp)
		if resp.Error.Code != "invalid_request" || !strings.Contains(resp.Error.Message, ".git") || resp.Error.Hint == "" {
			t.Errorf("PUT %s error = %+v", p, resp.Error)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(dir, ".git/config")); string(b) != "[core]\n" {
		t.Fatalf(".git/config = %q", b)
	}
	if _, err := os.Stat(filepath.Join(dir, ".git/hooks/post-checkout")); err == nil {
		t.Fatal("a hook was written")
	}
	e.into(t, "GET", filesURL(pid, "/content", label, ".git/config"), nil, http.StatusOK, nil)
}

func TestFileEndpointErrors(t *testing.T) {
	e := newEnv(t, nil)
	pid, label, _ := newFileProject(t, e)
	for _, tc := range []struct {
		name, kind, folder, path string
		status                   int
		code                     string
	}{
		{"unknown folder", "", "nope", "", 404, "not_found"},
		{"empty folder", "", "", "", 404, "not_found"},
		{"list missing dir", "", label, "missing", 404, "not_found"},
		{"list a file", "", label, "a.txt", 404, "not_found"},
		{"list traversal", "", label, "../", 400, "invalid_request"},
		{"list absolute", "", label, "/etc", 400, "invalid_request"},
		{"list symlink dir", "", label, "out", 400, "invalid_request"},
		{"read traversal", "/content", label, "../x", 400, "invalid_request"},
		{"read absolute", "/content", label, "/etc/passwd", 400, "invalid_request"},
		{"read missing", "/content", label, "missing.txt", 404, "not_found"},
		{"read dir", "/content", label, "src", 400, "invalid_request"},
		{"read too large", "/content", label, "big.txt", 413, "file_too_large"},
		{"read binary", "/content", label, "bin.dat", 415, "binary_file"},
		{"read unknown folder", "/content", "nope", "a.txt", 404, "not_found"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e.wantError(t, "GET", filesURL(pid, tc.kind, tc.folder, tc.path), nil, tc.status, tc.code)
		})
	}
	e.wantError(t, "GET", filesURL("nope", "", label, ""), nil, 404, "not_found")
	e.wantError(t, "PUT", "/v1/projects/"+pid+"/files/content",
		map[string]any{"folder": "nope", "path": "a.txt", "content": "x"}, 404, "not_found")
	e.wantError(t, "PUT", "/v1/projects/"+pid+"/files/content",
		map[string]any{"folder": label, "path": "a.txt", "content": "x", "expected_mtime": "yesterday"}, 400, "invalid_request")
}

func TestFileReadBase64(t *testing.T) {
	e := newEnv(t, nil)
	pid, label, _ := newFileProject(t, e)
	b64 := func(path string) string { return filesURL(pid, "/content", label, path) + "&encoding=base64" }
	var rd struct {
		fileStat
		Content, Encoding string
	}
	e.into(t, "GET", b64("bin.dat"), nil, http.StatusOK, &rd)
	if rd.Content != "AAEC" || rd.Encoding != "base64" || rd.Size != 3 || rd.Path != "bin.dat" || rd.Folder != label {
		t.Fatalf("base64 read = %+v", rd)
	}
	e.into(t, "GET", b64("a.txt"), nil, http.StatusOK, &rd)
	if rd.Content != "YWxwaGE=" {
		t.Fatalf("base64 text read = %+v", rd)
	}
	e.wantError(t, "GET", b64("big.txt"), nil, 413, "file_too_large")
	e.wantError(t, "GET", b64("../x"), nil, 400, "invalid_request")
	e.wantError(t, "GET", b64("missing.png"), nil, 404, "not_found")
	e.wantError(t, "GET", b64("src"), nil, 400, "invalid_request")
	e.wantError(t, "GET", filesURL(pid, "/content", label, "a.txt")+"&encoding=hex", nil, 400, "invalid_request")
}

func TestProjectWithoutFolders(t *testing.T) {
	e := newEnv(t, nil)
	var p project.Project
	e.into(t, "POST", "/v1/projects", map[string]any{"name": "Empty"}, http.StatusCreated, &p)
	e.wantError(t, "GET", filesURL(p.ID, "", "x", ""), nil, 404, "not_found")
}

func TestAgentWriteEmitsFileChanged(t *testing.T) {
	e := newEnv(t, nil)
	pid, label, dir := newFileProject(t, e)
	stream := e.subscribe(t, pid)
	e.into(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": "Add a demo note [write]"}, http.StatusAccepted, nil)
	evs := collectUntilTurnFinished(t, stream)

	var agentEvents int
	for _, ev := range evs {
		if ev.Type != events.FileChanged {
			continue
		}
		if ev.Data["source"] != "agent" || ev.Data["folder"] != label || ev.Data["path"] != "octo-demo-note.md" {
			t.Fatalf("file.changed = %+v", ev.Data)
		}
		agentEvents++
	}
	if agentEvents == 0 {
		t.Fatal("no file.changed event with source agent")
	}
	if b, err := os.ReadFile(filepath.Join(dir, "octo-demo-note.md")); err != nil || !strings.Contains(string(b), "Note from the") {
		t.Fatalf("note = %q, %v", b, err)
	}
}

// A directory entry carries `chain` (compact folders) only when it has one; a file never does.
func TestFileListChain(t *testing.T) {
	e := newEnv(t, nil)
	pid, label, dir := newFileProject(t, e)
	if err := os.MkdirAll(filepath.Join(dir, "lib", "src", "main", "java", "com", "acme"), 0o755); err != nil {
		t.Fatal(err)
	}
	var list struct {
		Entries []map[string]any
	}
	e.into(t, "GET", filesURL(pid, "", label, ""), nil, http.StatusOK, &list)
	for _, en := range list.Entries {
		chain, has := en["chain"]
		if en["name"] == "lib" {
			if got, _ := chain.([]any); len(got) != 5 || got[0] != "src" || got[4] != "acme" {
				t.Fatalf("lib chain = %v", chain)
			}
		} else if has {
			t.Fatalf("%v has chain %v", en["name"], chain)
		}
	}
}
