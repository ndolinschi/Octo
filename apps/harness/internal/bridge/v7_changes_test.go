package bridge_test

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/changes"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// v7Project creates a project over a fresh folder with the given access mode.
func (e *env) v7Project(t *testing.T, access string) (pid, folder string) {
	t.Helper()
	folder = t.TempDir()
	if err := os.WriteFile(filepath.Join(folder, "README.md"), []byte("# demo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	body := map[string]any{"name": "v7", "folders": []map[string]string{{"path": folder}}}
	if access != "" {
		body["access"] = access
	}
	var proj project.Project
	e.into(t, "POST", "/v1/projects", body, http.StatusCreated, &proj)
	return proj.ID, folder
}

func (e *env) runTurn(t *testing.T, pid, text string) []sseEvent {
	t.Helper()
	stream := e.subscribe(t, pid)
	e.into(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": text}, http.StatusAccepted, nil)
	return collectUntilTurnFinished(t, stream)
}

type turnsResp struct {
	Turns []changes.TurnChanges `json:"turns"`
}

func TestChangesPerTurnAcrossAgents(t *testing.T) {
	e := newEnv(t, nil)
	pid, folder := e.v7Project(t, "full")
	evs := e.runTurn(t, pid, "Do it [rewrite:{role}.txt]")
	if n := count(evs, "change.recorded"); n != 6 {
		t.Fatalf("change.recorded events = %d, want 6 (three agents, two writes each)", n)
	}

	var got turnsResp
	e.into(t, "GET", "/v1/projects/"+pid+"/changes", nil, http.StatusOK, &got)
	if len(got.Turns) != 1 {
		t.Fatalf("turns = %+v", got.Turns)
	}
	tc := got.Turns[0]
	if len(tc.Files) != 3 || tc.Added != 9 || tc.Removed != 0 {
		t.Fatalf("turn = %+v", tc)
	}
	for _, f := range tc.Files {
		if f.Kind != "created" || *f.Added != 3 || len(f.ChangeIDs) != 2 || len(f.AgentIDs) != 1 {
			t.Errorf("file = %+v", f)
		}
	}
	var one turnsResp
	e.into(t, "GET", "/v1/projects/"+pid+"/changes?turn="+itoa(tc.TurnID), nil, http.StatusOK, &one)
	if len(one.Turns) != 1 {
		t.Fatalf("turn filter: %+v", one)
	}
	e.wantError(t, "GET", "/v1/projects/"+pid+"/changes?turn=x", nil, http.StatusBadRequest, "invalid_request")

	// The detail of the first change of a file: created, content after only.
	first := tc.Files[0]
	var d changes.Detail
	e.into(t, "GET", "/v1/projects/"+pid+"/changes/"+itoa(first.ChangeIDs[0]), nil, http.StatusOK, &d)
	if !d.DiffAvailable || d.Before != nil || d.After == nil || *d.After != "line one\nline two\n" || d.Kind != "created" {
		t.Fatalf("detail = %+v", d)
	}
	e.wantError(t, "GET", "/v1/projects/"+pid+"/changes/9999", nil, http.StatusNotFound, "not_found")

	// Revert the later change: refused for the earlier (file no longer equals its after) ...
	e.wantError(t, "POST", "/v1/projects/"+pid+"/changes/"+itoa(first.ChangeIDs[0])+"/revert", nil, http.StatusConflict, "file_changed")
	// ... the last one restores the first version, and then the first one removes the file.
	var st project.RevertResult
	e.into(t, "POST", "/v1/projects/"+pid+"/changes/"+itoa(first.ChangeIDs[1])+"/revert", nil, http.StatusOK, &st)
	data, err := os.ReadFile(filepath.Join(folder, first.Path))
	if err != nil || string(data) != "line one\nline two\n" {
		t.Fatalf("after revert: %q %v", data, err)
	}
	e.into(t, "POST", "/v1/projects/"+pid+"/changes/"+itoa(first.ChangeIDs[0])+"/revert", nil, http.StatusOK, &st)
	if !st.Deleted {
		t.Fatalf("revert of a created file: %+v", st)
	}
	if _, err := os.Stat(filepath.Join(folder, first.Path)); !os.IsNotExist(err) {
		t.Fatalf("created file still there: %v", err)
	}
	// Created and reverted away: the file leaves the list, the other two stay.
	e.into(t, "GET", "/v1/projects/"+pid+"/changes", nil, http.StatusOK, &got)
	if len(got.Turns) != 1 || len(got.Turns[0].Files) != 2 {
		t.Fatalf("after reverting %s: %+v", first.Path, got.Turns)
	}
	for _, f := range got.Turns[0].Files {
		if f.Path == first.Path {
			t.Fatalf("reverted file still listed: %+v", f)
		}
	}
}

// A revert is recorded as a change of the turn it undoes (change.recorded): a file reverted to what it was before the
// turn leaves GET /changes (also ?session=), the way a file an agent created and deleted again does (v7 §1).
func TestRevertedFilesLeaveTheChanges(t *testing.T) {
	e := newEnv(t, nil)
	pid, folder := e.v7Project(t, "full")
	if err := os.WriteFile(filepath.Join(folder, "old.txt"), []byte("a\nb\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cmd := "printf 'a\\nB\\nc\\n' > old.txt && echo hi > made.txt && rm README.md"
	e.runTurn(t, pid, "Run it [bash:"+cmd+"]")
	list := func(query string) map[string]changes.FileChangeSummary {
		t.Helper()
		var got turnsResp
		e.into(t, "GET", "/v1/projects/"+pid+"/changes"+query, nil, http.StatusOK, &got)
		out := map[string]changes.FileChangeSummary{}
		for _, tc := range got.Turns {
			for _, f := range tc.Files {
				out[f.Path] = f
			}
		}
		return out
	}
	byPath := list("")
	if len(byPath) != 3 {
		t.Fatalf("files = %+v", byPath)
	}
	var sid string
	{
		var got turnsResp
		e.into(t, "GET", "/v1/projects/"+pid+"/changes", nil, http.StatusOK, &got)
		sid = got.Turns[0].SessionID
	}
	stream := e.subscribe(t, pid)
	left := 3
	for _, path := range []string{"made.txt", "old.txt", "README.md"} {
		var st project.RevertResult
		e.into(t, "POST", "/v1/projects/"+pid+"/changes/"+itoa(byPath[path].ChangeIDs[0])+"/revert", nil, http.StatusOK, &st)
		left--
		ev := waitEvent(t, stream, "change.recorded")
		if c, _ := ev.Data["change"].(map[string]any); c == nil || c["path"] != path {
			t.Fatalf("change.recorded after reverting %s = %+v", path, ev.Data)
		}
		now := list("")
		if _, ok := now[path]; ok || len(now) != left {
			t.Fatalf("after reverting %s: %+v", path, now)
		}
		if sid != "" {
			if scoped := list("?session=" + sid); len(scoped) != left {
				t.Fatalf("after reverting %s, ?session=%s: %+v", path, sid, scoped)
			}
		}
	}
	if b, _ := os.ReadFile(filepath.Join(folder, "old.txt")); string(b) != "a\nb\n" {
		t.Fatalf("old.txt after revert: %q", b)
	}
}

func TestBashChangesAreRecorded(t *testing.T) {
	e := newEnv(t, nil)
	pid, folder := e.v7Project(t, "full")
	if err := os.WriteFile(filepath.Join(folder, "old.txt"), []byte("a\nb\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cmd := "printf 'a\\nB\\nc\\n' > old.txt && echo hi > made.txt && rm README.md"
	e.runTurn(t, pid, "Run it [bash:"+cmd+"]")

	var got turnsResp
	e.into(t, "GET", "/v1/projects/"+pid+"/changes", nil, http.StatusOK, &got)
	byPath := map[string]changes.FileChangeSummary{}
	for _, tc := range got.Turns {
		for _, f := range tc.Files {
			byPath[f.Path] = f
		}
	}
	// Three sub-agents run the same command: the first to finish gets the changes, once.
	if len(byPath) != 3 {
		t.Fatalf("files = %+v", byPath)
	}
	if f := byPath["old.txt"]; f.Kind != "modified" || *f.Added != 2 || *f.Removed != 1 || f.Source != "bash" {
		t.Errorf("old.txt = %+v", f)
	}
	if f := byPath["made.txt"]; f.Kind != "created" || *f.Added != 1 {
		t.Errorf("made.txt = %+v", f)
	}
	if f := byPath["README.md"]; f.Kind != "deleted" || *f.Removed != 1 {
		t.Errorf("README.md = %+v", f)
	}
	// Reverting the delete brings the file back.
	var st project.RevertResult
	e.into(t, "POST", "/v1/projects/"+pid+"/changes/"+itoa(byPath["README.md"].ChangeIDs[0])+"/revert", nil, http.StatusOK, &st)
	if b, _ := os.ReadFile(filepath.Join(folder, "README.md")); strings.TrimSpace(string(b)) != "# demo" {
		t.Fatalf("README.md after revert: %q", b)
	}
}

func TestOldProjectHasNoChanges(t *testing.T) {
	e := newEnv(t, nil)
	pid, _ := e.v7Project(t, "")
	var got turnsResp
	e.into(t, "GET", "/v1/projects/"+pid+"/changes", nil, http.StatusOK, &got)
	if got.Turns == nil || len(got.Turns) != 0 {
		t.Fatalf("turns = %+v", got.Turns)
	}
	_ = projectstore.ChangeCreated
}
