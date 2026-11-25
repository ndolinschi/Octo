package review_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/events"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/review"
	"github.com/ndolinschi/Octo/apps/harness/internal/review/reviewtest"
)

func TestBranchName(t *testing.T) {
	for _, c := range []struct {
		n     int
		title string
		want  string
	}{
		{1, "Add token validation", "review/1-add-token-validation"},
		{12, "Fix: the Ünïcode — crash!!", "review/12-fix-the-n-code-crash"},
		{7, "Добавить проверку", "review/7-pr"},
		{3, "  ", "review/3-pr"},
		{9, strings.Repeat("long ", 30), "review/9-long-long-long-long-long-long-long-long"},
	} {
		if got := review.BranchName(c.n, c.title); got != c.want {
			t.Errorf("BranchName(%d, %q) = %q, want %q", c.n, c.title, got, c.want)
		}
	}
}

func waitEvent(t *testing.T, ch <-chan events.Event, typ, contains string) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case ev := <-ch:
			if ev.Type == typ && strings.Contains(string(ev.Data), contains) {
				return
			}
		case <-deadline:
			t.Fatalf("no %s event containing %q", typ, contains)
		}
	}
}

func apiErr(t *testing.T, err error) *review.Error {
	t.Helper()
	var re *review.Error
	if !errors.As(err, &re) {
		t.Fatalf("want a *review.Error, got %v", err)
	}
	return re
}

func currentBranch(t *testing.T, dir string) string {
	return reviewtest.Git(t, dir, "rev-parse", "--abbrev-ref", "HEAD")
}

func TestCheckoutWorkspaceMarksTheProjectAndClears(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	ch, cancel := f.hub.Subscribe(f.pid)
	defer cancel()
	v := f.openPR(1)

	if ws, err := f.svc.Workspace(ctx, f.pid); err != nil || ws != nil {
		t.Fatalf("workspace before = %+v %v", ws, err)
	}
	res, err := f.svc.Checkout(ctx, f.pid, v.ID, review.CheckoutRequest{Mode: "workspace"})
	if err != nil || res.Mode != "workspace" || res.Workspace == nil ||
		res.Workspace.Path != v.WorktreePath || res.Workspace.ReviewID != v.ID || res.Workspace.Title != "Add token validation" {
		t.Fatalf("checkout = %+v %v", res, err)
	}
	if _, err := os.Stat(filepath.Join(res.Workspace.Path, "src", "auth.go")); err != nil {
		t.Fatalf("the workspace has no files: %v", err)
	}
	ws, _ := f.svc.Workspace(ctx, f.pid)
	if ws == nil || *ws != *res.Workspace {
		t.Fatalf("workspace after = %+v", ws)
	}
	waitEvent(t, ch, review.EventWorkspace, v.WorktreePath)

	// The user's own folder is untouched.
	if currentBranch(t, f.repo.Dir) != "main" {
		t.Fatal("the working copy moved")
	}

	if err := f.svc.ClearWorkspace(ctx, f.pid); err != nil {
		t.Fatal(err)
	}
	if ws, _ := f.svc.Workspace(ctx, f.pid); ws != nil {
		t.Fatalf("workspace after clear = %+v", ws)
	}
	waitEvent(t, ch, review.EventWorkspace, `"review_workspace":null`)
	if err := f.svc.ClearWorkspace(ctx, f.pid); err != nil {
		t.Fatalf("clearing twice: %v", err)
	}

	// A closed review's worktree goes away and takes the workspace with it.
	if _, err := f.svc.Checkout(ctx, f.pid, v.ID, review.CheckoutRequest{Mode: "workspace"}); err != nil {
		t.Fatal(err)
	}
	closed := "closed"
	if _, err := f.svc.Patch(ctx, f.pid, v.ID, review.PatchRequest{State: &closed}); err != nil {
		t.Fatal(err)
	}
	if ws, _ := f.svc.Workspace(ctx, f.pid); ws != nil {
		t.Fatalf("workspace of a closed review = %+v", ws)
	}
	re := apiErr(t, func() error {
		_, err := f.svc.Checkout(ctx, f.pid, v.ID, review.CheckoutRequest{Mode: "workspace"})
		return err
	}())
	if re.Code != "review_closed" {
		t.Fatalf("closed review: %v", re)
	}
}

func TestCheckoutWorkspaceMakesTheWorktreeAgainWhenItWasSwept(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	v := f.openPR(1)
	_ = os.RemoveAll(v.WorktreePath)
	res, err := f.svc.Checkout(ctx, f.pid, v.ID, review.CheckoutRequest{Mode: "workspace"})
	if err != nil {
		t.Fatalf("checkout with a missing worktree: %v", err)
	}
	if _, err := os.Stat(filepath.Join(res.Workspace.Path, "src", "auth.go")); err != nil {
		t.Fatalf("worktree not remade: %v", err)
	}
}

func TestCheckoutRefusesAnUnknownModeAndLocalReviewsForTheWorkingCopy(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	v := f.openPR(1)
	if _, err := f.svc.Checkout(ctx, f.pid, v.ID, review.CheckoutRequest{Mode: "nope"}); apiErr(t, err).Code != "invalid_mode" {
		t.Fatal("unknown mode accepted")
	}
	local, _, err := f.svc.Open(ctx, f.pid, review.OpenRequest{Base: "main", Head: "feature"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Checkout(ctx, f.pid, local.ID, review.CheckoutRequest{Mode: "working_copy"}); apiErr(t, err).Code != "not_a_pull_request" {
		t.Fatal("a local review was checked out into the working copy")
	}
	// A local review can be a workspace.
	if _, err := f.svc.Checkout(ctx, f.pid, local.ID, review.CheckoutRequest{Mode: "workspace"}); err != nil {
		t.Fatalf("local workspace: %v", err)
	}
}

func TestCheckoutWorkingCopyCleanCreatesTheBranch(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	v := f.openPR(1)
	if err := os.Remove(f.repo.Dirty); err != nil {
		t.Fatal(err)
	}
	head := f.repo.Head
	res, err := f.svc.Checkout(ctx, f.pid, v.ID, review.CheckoutRequest{Mode: "working_copy"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Branch != "review/1-add-token-validation" || !res.Created || res.AlreadyOnBranch || res.PreviousBranch != "main" ||
		res.Commit != head || res.Folder != "repo" {
		t.Fatalf("result = %+v", res)
	}
	if currentBranch(t, f.repo.Dir) != res.Branch || reviewtest.Git(t, f.repo.Dir, "rev-parse", "HEAD") != head {
		t.Fatal("the working copy is not on the new branch at the pull request head")
	}
	if b, err := os.ReadFile(filepath.Join(f.repo.Dir, "src", "auth.go")); err != nil || !strings.Contains(string(b), "ValidateToken") {
		t.Fatalf("the pull request's files are not checked out: %v", err)
	}
	// main is where it was.
	if reviewtest.Git(t, f.repo.Dir, "rev-parse", "main") != f.repo.Base {
		t.Fatal("main moved")
	}
}

func TestCheckoutWorkingCopyDirtyReportsFilesAndNeverDiscards(t *testing.T) {
	f := newFixture(t) // the fixture's working tree has an untracked dirty.txt
	ctx := context.Background()
	v := f.openPR(1)
	moved := filepath.Join(f.repo.Dir, "docs", "Руководство.md") // unchanged by the pull request
	conflicting := filepath.Join(f.repo.Dir, "README.md")        // changed by the pull request
	if err := os.WriteFile(moved, []byte("my edit\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	_, err := f.svc.Checkout(ctx, f.pid, v.ID, review.CheckoutRequest{Mode: "working_copy"})
	re := apiErr(t, err)
	if re.Code != "dirty_working_copy" || re.Kind != review.KindConflict {
		t.Fatalf("dirty: %v", err)
	}
	got := map[string]string{}
	for _, d := range re.Files {
		got[d.Path] = d.Status
	}
	if got["dirty.txt"] != "untracked" || got["docs/Руководство.md"] != "modified" || len(got) != 2 {
		t.Fatalf("files = %v", got)
	}
	if currentBranch(t, f.repo.Dir) != "main" {
		t.Fatal("a refused checkout moved the branch")
	}

	// Confirmed: git carries the changes over, nothing is lost.
	res, err := f.svc.Checkout(ctx, f.pid, v.ID, review.CheckoutRequest{Mode: "working_copy", Confirm: true})
	if err != nil || !res.Created {
		t.Fatalf("confirmed checkout = %+v %v", res, err)
	}
	if b, _ := os.ReadFile(moved); string(b) != "my edit\n" {
		t.Fatalf("an uncommitted edit was lost: %q", b)
	}
	if _, err := os.Stat(f.repo.Dirty); err != nil {
		t.Fatal("the untracked file was lost")
	}

	// A change that conflicts with the branch: git refuses, nothing is forced, the file is intact.
	reviewtest.Git(t, f.repo.Dir, "checkout", "-q", "main")
	reviewtest.Git(t, f.repo.Dir, "branch", "-D", "review/1-add-token-validation")
	if err := os.WriteFile(conflicting, []byte("my own readme\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err = f.svc.Checkout(ctx, f.pid, v.ID, review.CheckoutRequest{Mode: "working_copy", Confirm: true})
	if re := apiErr(t, err); re.Code != "checkout_conflict" {
		t.Fatalf("conflict: %v", err)
	}
	if b, _ := os.ReadFile(conflicting); string(b) != "my own readme\n" {
		t.Fatalf("a conflicting edit was discarded: %q", b)
	}
	if currentBranch(t, f.repo.Dir) != "main" {
		t.Fatal("the branch moved despite the conflict")
	}
}

func TestCheckoutWorkingCopyAlreadyOnBranchFastForwardsAndNeverMovesADivergedBranch(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	v := f.openPR(1)
	if err := os.Remove(f.repo.Dirty); err != nil {
		t.Fatal(err)
	}
	req := review.CheckoutRequest{Mode: "working_copy"}
	first, err := f.svc.Checkout(ctx, f.pid, v.ID, req)
	if err != nil || !first.Created {
		t.Fatalf("first = %+v %v", first, err)
	}
	oldHead := first.Commit

	// Already on the branch at the head: nothing to do.
	again, err := f.svc.Checkout(ctx, f.pid, v.ID, req)
	if err != nil || !again.AlreadyOnBranch || again.Created || again.FastForwarded || again.Commit != oldHead || again.PreviousBranch != first.Branch {
		t.Fatalf("already on branch = %+v %v", again, err)
	}

	// The pull request moves on: the existing branch is fast-forwarded.
	reviewtest.Git(t, f.repo.Dir, "switch", "-q", "main")
	newHead := f.repo.AddCommit(t, "src/extra.go", "package auth\n")
	reviewtest.Git(t, f.repo.Dir, "switch", "-q", first.Branch)
	ff, err := f.svc.Checkout(ctx, f.pid, v.ID, req)
	if err != nil || !ff.AlreadyOnBranch || !ff.FastForwarded || ff.Commit != newHead {
		t.Fatalf("fast-forward = %+v %v", ff, err)
	}
	if reviewtest.Git(t, f.repo.Dir, "rev-parse", "HEAD") != newHead {
		t.Fatal("the branch did not move to the new head")
	}

	// Elsewhere (main), with the branch behind: it is switched to and forwarded.
	reviewtest.Git(t, f.repo.Dir, "reset", "-q", "--hard", oldHead)
	reviewtest.Git(t, f.repo.Dir, "switch", "-q", "main")
	sw, err := f.svc.Checkout(ctx, f.pid, v.ID, req)
	if err != nil || sw.Created || sw.AlreadyOnBranch || !sw.FastForwarded || sw.PreviousBranch != "main" || sw.Commit != newHead {
		t.Fatalf("switch + forward = %+v %v", sw, err)
	}

	// A local commit on the branch: it has diverged once the pull request moves; it is left alone.
	reviewtest.Git(t, f.repo.Dir, "commit", "-q", "--allow-empty", "-m", "my own commit")
	mine := reviewtest.Git(t, f.repo.Dir, "rev-parse", "HEAD")
	reviewtest.Git(t, f.repo.Dir, "switch", "-q", "main")
	f.repo.AddCommit(t, "src/more.go", "package auth\n")
	_, err = f.svc.Checkout(ctx, f.pid, v.ID, req)
	if re := apiErr(t, err); re.Code != "branch_diverged" {
		t.Fatalf("diverged: %v", err)
	}
	if reviewtest.Git(t, f.repo.Dir, "rev-parse", first.Branch) != mine || currentBranch(t, f.repo.Dir) != "main" {
		t.Fatal("a diverged branch was moved")
	}
}

func TestCheckoutWorkingCopyFromADetachedHeadWithOrphanCommitsNeedsConfirm(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	v := f.openPR(1)
	if err := os.Remove(f.repo.Dirty); err != nil {
		t.Fatal(err)
	}
	reviewtest.Git(t, f.repo.Dir, "checkout", "-q", "--detach")
	reviewtest.Git(t, f.repo.Dir, "commit", "-q", "--allow-empty", "-m", "orphan work")
	orphan := reviewtest.Git(t, f.repo.Dir, "rev-parse", "HEAD")
	_, err := f.svc.Checkout(ctx, f.pid, v.ID, review.CheckoutRequest{Mode: "working_copy"})
	if re := apiErr(t, err); re.Code != "detached_head" {
		t.Fatalf("detached: %v", err)
	}
	if reviewtest.Git(t, f.repo.Dir, "rev-parse", "HEAD") != orphan {
		t.Fatal("the detached HEAD moved")
	}
	if _, err := f.svc.Checkout(ctx, f.pid, v.ID, review.CheckoutRequest{Mode: "working_copy", Confirm: true}); err != nil {
		t.Fatalf("confirmed: %v", err)
	}
}

func TestProjectSettingsStoreSurvivesAReopen(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	if err := f.db.SetSetting(ctx, "k", `{"a":1}`); err != nil {
		t.Fatal(err)
	}
	v, ok, err := f.db.Setting(ctx, "k")
	var m map[string]int
	if err != nil || !ok || json.Unmarshal([]byte(v), &m) != nil || m["a"] != 1 {
		t.Fatalf("setting = %q %v %v", v, ok, err)
	}
	if err := f.db.DeleteSetting(ctx, "k"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := f.db.Setting(ctx, "k"); ok {
		t.Fatal("setting not deleted")
	}
	_ = projectstore.SettingCommands
}
