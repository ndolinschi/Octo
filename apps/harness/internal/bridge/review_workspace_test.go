package bridge_test

import (
	"context"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/lsp"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// Check out (RV1.5): the route, the project's review_workspace field, and the
// file API's allowed root while a workspace is active.
func TestReviewAPICheckoutWorkspaceAndTheFileAPI(t *testing.T) {
	e := newReviewEnv(t, false)
	var rv map[string]any
	e.into(t, "POST", e.path("/reviews"), map[string]any{"pr": 1}, http.StatusCreated, &rv)
	rid, worktree := rv["id"].(string), rv["worktree_path"].(string)

	// No workspace: the reserved folder and the worktree's path are refused like any unknown folder.
	if p := e.get(t, ""); p["review_workspace"] != nil {
		t.Fatalf("review_workspace before = %v", p["review_workspace"])
	}
	e.wantError(t, "GET", e.path("/files?folder=@review&path="), nil, http.StatusNotFound, "not_found")
	e.wantError(t, "GET", e.path("/files?folder="+url.QueryEscape(worktree)+"&path="), nil, http.StatusNotFound, "not_found")

	var res map[string]any
	e.into(t, "POST", e.path("/reviews/"+rid+"/checkout"), map[string]any{"mode": "workspace"}, http.StatusOK, &res)
	ws, _ := res["workspace"].(map[string]any)
	if res["mode"] != "workspace" || ws["path"] != worktree || ws["review_id"] != rid || ws["title"] != "Add token validation" {
		t.Fatalf("checkout = %v", res)
	}
	// GET project shows it.
	pw, _ := e.get(t, "")["review_workspace"].(map[string]any)
	if pw["review_id"] != rid || pw["path"] != worktree || pw["title"] != "Add token validation" {
		t.Fatalf("project.review_workspace = %v", pw)
	}

	// The file API accepts the worktree as a root (by the reserved label and by its path), read-only.
	for _, folder := range []string{"@review", worktree} {
		var list struct {
			Entries []struct{ Name, Path, Type string } `json:"entries"`
		}
		e.into(t, "GET", e.path("/files?folder="+url.QueryEscape(folder)+"&path=src"), nil, http.StatusOK, &list)
		names := []string{}
		for _, en := range list.Entries {
			names = append(names, en.Name)
		}
		if !strings.Contains(strings.Join(names, ","), "auth.go") {
			t.Fatalf("folder %q lists %v", folder, names)
		}
	}
	var fc struct{ Content string }
	e.into(t, "GET", e.path("/files/content?folder=@review&path=src/auth.go"), nil, http.StatusOK, &fc)
	if !strings.Contains(fc.Content, "ValidateToken") {
		t.Fatalf("content = %q", fc.Content)
	}
	// Still confined to the worktree, and never writable.
	e.wantError(t, "GET", e.path("/files/content?folder=@review&path=../../etc/passwd"), nil, http.StatusBadRequest, "invalid_request")
	e.wantError(t, "PUT", e.path("/files/content"), map[string]any{"folder": "@review", "path": "src/auth.go", "content": "x"}, http.StatusConflict, "review_workspace_read_only")
	if b, _ := os.ReadFile(filepath.Join(worktree, "src", "auth.go")); !strings.Contains(string(b), "ValidateToken") {
		t.Fatal("the worktree was written")
	}
	// Some other absolute path is not an allowed root.
	e.wantError(t, "GET", e.path("/files?folder="+url.QueryEscape(filepath.Dir(worktree))+"&path="), nil, http.StatusNotFound, "not_found")
	e.wantError(t, "GET", e.path("/files?folder=/etc&path="), nil, http.StatusNotFound, "not_found")

	// Cleared: refused again.
	e.into(t, "DELETE", e.path("/review-workspace"), nil, http.StatusNoContent, nil)
	if p := e.get(t, ""); p["review_workspace"] != nil {
		t.Fatalf("review_workspace after clear = %v", p["review_workspace"])
	}
	e.wantError(t, "GET", e.path("/files?folder=@review&path="), nil, http.StatusNotFound, "not_found")
	e.into(t, "DELETE", e.path("/review-workspace"), nil, http.StatusNoContent, nil)
}

func TestReviewAPICheckoutWorkingCopy(t *testing.T) {
	e := newReviewEnv(t, false)
	var rv map[string]any
	e.into(t, "POST", e.path("/reviews"), map[string]any{"pr": 1}, http.StatusCreated, &rv)
	rid := rv["id"].(string)

	var bad struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
			Files   []struct {
				Path, Status, Code string
			} `json:"files"`
		} `json:"error"`
	}
	e.into(t, "POST", e.path("/reviews/"+rid+"/checkout"), map[string]any{"mode": "working_copy"}, http.StatusConflict, &bad)
	if bad.Error.Code != "dirty_working_copy" || len(bad.Error.Files) != 1 || bad.Error.Files[0].Path != "dirty.txt" ||
		bad.Error.Files[0].Status != "untracked" || bad.Error.Files[0].Code != "??" {
		t.Fatalf("dirty = %+v", bad.Error)
	}
	var res map[string]any
	e.into(t, "POST", e.path("/reviews/"+rid+"/checkout"), map[string]any{"mode": "working_copy", "confirm": true}, http.StatusOK, &res)
	if res["mode"] != "working_copy" || res["branch"] != "review/1-add-token-validation" || res["created"] != true ||
		res["previous_branch"] != "main" || res["commit"] != e.repo.Head || res["folder"] == "" {
		t.Fatalf("checkout = %v", res)
	}
	e.wantError(t, "POST", e.path("/reviews/"+rid+"/checkout"), map[string]any{"mode": "bogus"}, http.StatusBadRequest, "invalid_mode")
	e.wantError(t, "POST", e.path("/reviews/nope/checkout"), map[string]any{"mode": "workspace"}, http.StatusNotFound, "not_found")
}

// The language server can be started on the review workspace instead of the project's folders.
func TestLSPSessionOnTheReviewWorkspace(t *testing.T) {
	e := newLSPEnv(t, lsp.Options{})
	folder, worktree := t.TempDir(), t.TempDir()
	pid := newLSPProject(t, e, folder)
	e.wantError(t, "POST", "/v1/projects/"+pid+"/lsp/fake/sessions?workspace=review", nil, http.StatusConflict, "no_review_workspace")

	db, err := e.store.Get(context.Background(), pid)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.SetReviewWorkspace(context.Background(), projectstore.ReviewWorkspace{ReviewID: "rev_x", Path: worktree, Title: "t"}); err != nil {
		t.Fatal(err)
	}
	var s lspSession
	e.into(t, "POST", "/v1/projects/"+pid+"/lsp/fake/sessions?workspace=review", nil, http.StatusCreated, &s)
	u, err := url.Parse(s.RootURI)
	if err != nil || u.Path != worktree || len(s.Folders) != 1 || s.Folders[0]["name"] != "@review" {
		t.Fatalf("session = %+v (root path %q, want %q)", s, u.Path, worktree)
	}
	// Without the parameter the project's folders are used, as before.
	s = e.newSession(t, pid, "fake")
	if u, _ := url.Parse(s.RootURI); u.Path != folder {
		t.Fatalf("default root = %q, want %q", u.Path, folder)
	}
}
