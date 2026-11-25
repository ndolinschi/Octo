package bridge_test

import (
	"context"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/gitx"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
)

// branchRepo makes a git repository on main with the branches older and newer.
func branchRepo(t *testing.T, name string) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	dir := filepath.Join(t.TempDir(), name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{
		{"init", "-q", "-b", "main"},
		{"config", "user.name", "Test"},
		{"config", "user.email", "test@example.com"},
	} {
		gitIn(t, dir, args...)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("v1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitIn(t, dir, "add", "a.txt")
	gitIn(t, dir, "commit", "-q", "-m", "init")
	gitIn(t, dir, "branch", "older")
	gitIn(t, dir, "branch", "newer")
	return dir
}

func gitIn(t *testing.T, dir string, args ...string) string {
	t.Helper()
	out, err := gitx.Run(context.Background(), dir, args...)
	if err != nil {
		t.Fatalf("git %v: %v", args, err)
	}
	return strings.TrimSpace(string(out))
}

func (e *env) folderProject(t *testing.T, dirs ...string) string {
	t.Helper()
	folders := make([]map[string]string, 0, len(dirs))
	for _, d := range dirs {
		folders = append(folders, map[string]string{"path": d})
	}
	var p project.Project
	e.into(t, "POST", "/v1/projects", map[string]any{"name": "B", "folders": folders}, http.StatusCreated, &p)
	return p.ID
}

type branchesResp struct {
	Workspace       string               `json:"workspace"`
	RunningSessions int                  `json:"running_sessions"`
	Repos           []project.RepoBranch `json:"repos"`
}

type errResp struct {
	Error struct {
		Code, Message, Hint, Action, Details string
	} `json:"error"`
}

func TestBranchesListAndSwitch(t *testing.T) {
	e := newEnv(t, nil)
	repo := branchRepo(t, "app")
	pid := e.folderProject(t, repo)

	var got branchesResp
	e.into(t, "GET", "/v1/projects/"+pid+"/branches", nil, http.StatusOK, &got)
	if got.Workspace != "shared" || len(got.Repos) != 1 {
		t.Fatalf("list = %+v", got)
	}
	r := got.Repos[0]
	if r.Branch != "main" || r.Head == "" || r.DirtyFiles != 0 || r.Total != 3 || len(r.Branches) != 3 || !r.Branches[0].Current || r.Branches[0].Name != "main" {
		t.Fatalf("repo = %+v", r)
	}
	if r.Folder != "app" || r.RepoName != "app" || r.FolderID == "" {
		t.Fatalf("repo names = %+v", r)
	}

	// Paging and search.
	got = branchesResp{}
	e.into(t, "GET", "/v1/projects/"+pid+"/branches?limit=2", nil, http.StatusOK, &got)
	if r := got.Repos[0]; len(r.Branches) != 2 || r.NextOffset == nil || *r.NextOffset != 2 {
		t.Fatalf("page 1 = %+v", r)
	}
	got = branchesResp{}
	e.into(t, "GET", "/v1/projects/"+pid+"/branches?folder=app&offset=2&limit=2", nil, http.StatusOK, &got)
	if r := got.Repos[0]; len(r.Branches) != 1 || r.NextOffset != nil {
		t.Fatalf("page 2 = %+v", r)
	}
	e.into(t, "GET", "/v1/projects/"+pid+"/branches?q=OLD", nil, http.StatusOK, &got)
	if r := got.Repos[0]; r.Total != 1 || r.Branches[0].Name != "older" || r.Branch != "main" {
		t.Fatalf("search = %+v", r)
	}

	// Switch on a clean tree.
	var sw struct {
		Repo project.RepoBranch `json:"repo"`
	}
	e.into(t, "POST", "/v1/projects/"+pid+"/branches/switch", map[string]any{"branch": "older"}, http.StatusOK, &sw)
	if sw.Repo.Branch != "older" || gitIn(t, repo, "branch", "--show-current") != "older" {
		t.Fatalf("switch = %+v", sw.Repo)
	}
	// Create and switch.
	e.into(t, "POST", "/v1/projects/"+pid+"/branches/switch", map[string]any{"branch": "feature/new", "create": true}, http.StatusOK, &sw)
	if sw.Repo.Branch != "feature/new" || gitIn(t, repo, "branch", "--show-current") != "feature/new" {
		t.Fatalf("create = %+v", sw.Repo)
	}
	e.wantError(t, "POST", "/v1/projects/"+pid+"/branches/switch", map[string]any{"branch": "older", "create": true}, http.StatusConflict, "branch_exists")
	e.wantError(t, "POST", "/v1/projects/"+pid+"/branches/switch", map[string]any{"branch": "a..b", "create": true}, http.StatusBadRequest, "invalid_branch_name")
	e.wantError(t, "POST", "/v1/projects/"+pid+"/branches/switch", map[string]any{"branch": ""}, http.StatusBadRequest, "invalid_branch_name")
	e.wantError(t, "GET", "/v1/projects/"+pid+"/branches?limit=x", nil, http.StatusBadRequest, "invalid_request")

	// Unknown branch.
	var refused errResp
	e.into(t, "POST", "/v1/projects/"+pid+"/branches/switch", map[string]any{"branch": "nope"}, http.StatusNotFound, &refused)
	if refused.Error.Code != "branch_not_found" || refused.Error.Hint == "" {
		t.Fatalf("unknown = %+v", refused.Error)
	}

	// A detached HEAD reads as no branch with its short commit.
	gitIn(t, repo, "checkout", "-q", "--detach", "main")
	e.into(t, "GET", "/v1/projects/"+pid+"/branches", nil, http.StatusOK, &got)
	if r := got.Repos[0]; r.Branch != "" || !r.Detached || r.Head == "" {
		t.Fatalf("detached = %+v", r)
	}
}

func TestBranchSwitchRefusesADirtyTree(t *testing.T) {
	e := newEnv(t, nil)
	repo := branchRepo(t, "app")
	pid := e.folderProject(t, repo)
	if err := os.WriteFile(filepath.Join(repo, "a.txt"), []byte("edited\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var got branchesResp
	e.into(t, "GET", "/v1/projects/"+pid+"/branches", nil, http.StatusOK, &got)
	if got.Repos[0].DirtyFiles != 1 {
		t.Fatalf("dirty = %+v", got.Repos[0])
	}
	var refused errResp
	e.into(t, "POST", "/v1/projects/"+pid+"/branches/switch", map[string]any{"branch": "older"}, http.StatusConflict, &refused)
	if refused.Error.Code != "uncommitted_changes" || refused.Error.Action != "use_worktree" || !strings.Contains(refused.Error.Details, "a.txt") {
		t.Fatalf("dirty refusal = %+v", refused.Error)
	}
	if gitIn(t, repo, "branch", "--show-current") != "main" {
		t.Fatal("the checkout moved")
	}
	if b, _ := os.ReadFile(filepath.Join(repo, "a.txt")); string(b) != "edited\n" {
		t.Fatalf("the change was touched: %q", b)
	}
	// Creating a branch from the current one keeps the changes on the new branch: also refused (nothing moves).
	e.wantError(t, "POST", "/v1/projects/"+pid+"/branches/switch", map[string]any{"branch": "x", "create": true}, http.StatusConflict, "uncommitted_changes")

	// The safe alternative: a new session in a worktree from that branch leaves the main checkout alone.
	var created struct {
		Session struct {
			Workspace struct{ Kind, Branch string } `json:"workspace"`
		} `json:"session"`
	}
	e.into(t, "POST", "/v1/projects/"+pid+"/sessions", map[string]any{"workspace": map[string]any{"kind": "worktree", "base_ref": "older"}}, http.StatusCreated, &created)
	if created.Session.Workspace.Kind != "worktree" {
		t.Fatalf("worktree session = %+v", created.Session)
	}
	if gitIn(t, repo, "branch", "--show-current") != "main" {
		t.Fatal("the checkout moved")
	}
	// The worktree's own branch is listed for its workspace.
	var ws struct {
		Workspaces []struct{ ID, Kind string } `json:"workspaces"`
	}
	e.into(t, "GET", "/v1/projects/"+pid+"/workspaces", nil, http.StatusOK, &ws)
	wid := ""
	for _, w := range ws.Workspaces {
		if w.Kind == "worktree" {
			wid = w.ID
		}
	}
	e.into(t, "GET", "/v1/projects/"+pid+"/branches?workspace="+wid+"&limit=1", nil, http.StatusOK, &got)
	if got.Workspace != wid || len(got.Repos) != 1 || !strings.HasPrefix(got.Repos[0].Branch, "octo/") {
		t.Fatalf("worktree branches = %+v", got)
	}
}

func TestBranchesOfANonGitFolder(t *testing.T) {
	e := newEnv(t, nil)
	plain := t.TempDir()
	pid := e.folderProject(t, plain)
	var got branchesResp
	e.into(t, "GET", "/v1/projects/"+pid+"/branches", nil, http.StatusOK, &got)
	if len(got.Repos) != 0 {
		t.Fatalf("non-git = %+v", got)
	}
	e.wantError(t, "POST", "/v1/projects/"+pid+"/branches/switch", map[string]any{"branch": "main"}, http.StatusConflict, "not_a_git_repository")
}

func TestBranchesOfSeveralRepositories(t *testing.T) {
	e := newEnv(t, nil)
	api := branchRepo(t, "api")
	web := branchRepo(t, "web")
	gitIn(t, web, "switch", "-q", "newer")
	if err := os.MkdirAll(filepath.Join(api, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	// Two folders of one repository share one entry.
	pid := e.folderProject(t, api, filepath.Join(api, "sub"), web)
	var got branchesResp
	e.into(t, "GET", "/v1/projects/"+pid+"/branches", nil, http.StatusOK, &got)
	if len(got.Repos) != 2 || got.Repos[0].RepoName != "api" || got.Repos[0].Branch != "main" || got.Repos[1].RepoName != "web" || got.Repos[1].Branch != "newer" {
		t.Fatalf("repos = %+v", got.Repos)
	}
	var sw struct {
		Repo project.RepoBranch `json:"repo"`
	}
	e.into(t, "POST", "/v1/projects/"+pid+"/branches/switch", map[string]any{"folder": got.Repos[1].FolderID, "branch": "older"}, http.StatusOK, &sw)
	if gitIn(t, web, "branch", "--show-current") != "older" || gitIn(t, api, "branch", "--show-current") != "main" {
		t.Fatal("the switch acted on the wrong repository")
	}
}

func TestBranchSwitchRefusedWhileATurnRuns(t *testing.T) {
	gate := make(chan struct{}) // never fed: the model never answers
	e := newEnv(t, gate)
	t.Cleanup(func() { close(gate) })
	repo := branchRepo(t, "app")
	pid := e.folderProject(t, repo)
	stream := e.subscribe(t, pid)
	e.into(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": "wait"}, http.StatusAccepted, nil)
	deadline := time.Now().Add(10 * time.Second)
	for len(e.sessions(t, pid, "?state=working")) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("the session never showed as working")
		}
		time.Sleep(20 * time.Millisecond)
	}
	var got branchesResp
	e.into(t, "GET", "/v1/projects/"+pid+"/branches", nil, http.StatusOK, &got)
	if got.RunningSessions != 1 {
		t.Fatalf("running = %+v", got)
	}
	var refused errResp
	e.into(t, "POST", "/v1/projects/"+pid+"/branches/switch", map[string]any{"branch": "older"}, http.StatusConflict, &refused)
	if refused.Error.Code != "checkout_in_use" || refused.Error.Action != "use_worktree" {
		t.Fatalf("busy refusal = %+v", refused.Error)
	}
	if gitIn(t, repo, "branch", "--show-current") != "main" {
		t.Fatal("the checkout moved")
	}
	e.into(t, "POST", "/v1/projects/"+pid+"/cancel", nil, http.StatusAccepted, nil)
	collectUntilTurnFinished(t, stream)
	e.into(t, "POST", "/v1/projects/"+pid+"/branches/switch", map[string]any{"branch": "older"}, http.StatusOK, nil)
}
