package gitx

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// switchRepo is a repository on main with branches older and newer and one tracked file.
func switchRepo(t *testing.T) (context.Context, string, func(args ...string)) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	ctx := context.Background()
	repo := t.TempDir()
	mustGit := func(args ...string) {
		t.Helper()
		if _, err := Run(ctx, repo, args...); err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
	}
	mustGit("init", "-q", "-b", "main")
	mustGit("config", "user.name", "Test")
	mustGit("config", "user.email", "test@example.com")
	if err := os.WriteFile(filepath.Join(repo, "tracked.txt"), []byte("v1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustGit("add", "tracked.txt")
	mustGit("commit", "-q", "-m", "init")
	mustGit("branch", "older")
	mustGit("branch", "newer")
	return ctx, repo, mustGit
}

func TestLocalBranchesMatchingFiltersBeforePaging(t *testing.T) {
	ctx, repo, _ := switchRepo(t)
	list, total, _, err := LocalBranchesMatching(ctx, repo, "HEAD", "NEW", 0, 10)
	if err != nil || total != 1 || len(list) != 1 || list[0].Name != "newer" {
		t.Fatalf("matching NEW = %+v total=%d err=%v", list, total, err)
	}
	list, total, _, err = LocalBranchesMatching(ctx, repo, "HEAD", "", 0, 2)
	if err != nil || total != 3 || len(list) != 2 || list[0].Name != "main" || !list[0].Current {
		t.Fatalf("all, first page = %+v total=%d err=%v", list, total, err)
	}
}

func TestDirtyFilesCountsTrackedChangesOnly(t *testing.T) {
	ctx, repo, mustGit := switchRepo(t)
	if files, err := DirtyFiles(ctx, repo); err != nil || len(files) != 0 {
		t.Fatalf("clean = %v, %v", files, err)
	}
	if err := os.WriteFile(filepath.Join(repo, "untracked.txt"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if files, err := DirtyFiles(ctx, repo); err != nil || len(files) != 0 {
		t.Fatalf("untracked only = %v, %v", files, err)
	}
	if err := os.WriteFile(filepath.Join(repo, "tracked.txt"), []byte("v2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if files, err := DirtyFiles(ctx, repo); err != nil || len(files) != 1 || files[0] != "tracked.txt" {
		t.Fatalf("modified = %v, %v", files, err)
	}
	mustGit("checkout", "--", "tracked.txt")
	if err := os.WriteFile(filepath.Join(repo, "staged.txt"), []byte("s\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustGit("add", "staged.txt")
	if files, err := DirtyFiles(ctx, repo); err != nil || len(files) != 1 || files[0] != "staged.txt" {
		t.Fatalf("staged = %v, %v", files, err)
	}
}

func TestSwitchBranch(t *testing.T) {
	ctx, repo, mustGit := switchRepo(t)
	if err := SwitchBranch(ctx, repo, "older", false); err != nil {
		t.Fatalf("switch older: %v", err)
	}
	if b := CurrentBranch(ctx, repo); b != "older" {
		t.Fatalf("current = %q", b)
	}
	if err := SwitchBranch(ctx, repo, "nope", false); !errors.Is(err, ErrBranchNotFound) {
		t.Fatalf("unknown = %v", err)
	}
	if err := SwitchBranch(ctx, repo, "newer", true); !errors.Is(err, ErrBranchExists) {
		t.Fatalf("create existing = %v", err)
	}
	for _, bad := range []string{"", "-x", "a b", "a..b", "x.lock", "x~1"} {
		if err := SwitchBranch(ctx, repo, bad, true); !errors.Is(err, ErrInvalidBranchName) {
			t.Fatalf("create %q = %v", bad, err)
		}
	}
	if err := SwitchBranch(ctx, repo, "feature/x", true); err != nil {
		t.Fatalf("create feature/x: %v", err)
	}
	if b := CurrentBranch(ctx, repo); b != "feature/x" {
		t.Fatalf("current after create = %q", b)
	}
	if ref, _ := Resolve(ctx, repo, "feature/x"); ref == "" {
		t.Fatal("feature/x does not resolve")
	}
	// A detached HEAD reads as its short commit; switching from it works.
	mustGit("checkout", "-q", "--detach", "main")
	if b := CurrentBranch(ctx, repo); b != "" {
		t.Fatalf("detached current = %q", b)
	}
	if h := ShortHead(ctx, repo); len(h) < 7 {
		t.Fatalf("short head = %q", h)
	}
	if err := SwitchBranch(ctx, repo, "main", false); err != nil || CurrentBranch(ctx, repo) != "main" {
		t.Fatalf("switch from detached: %v", err)
	}
}
