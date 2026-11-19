package gitx

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// HostileRepo makes a repository whose own config and hooks run a program that creates a marker file in marks:
// core.fsmonitor, diff.external, a textconv driver, core.pager and the hooks a checkout, a worktree or a ref
// update fire. It returns the repository; the caller checks marks stays empty after the harness's git calls.
func hostileRepo(t *testing.T) (repo, marks string) {
	t.Helper()
	git, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git not available")
	}
	repo, marks = t.TempDir(), t.TempDir()
	script := filepath.Join(t.TempDir(), "mark.sh")
	if err := os.WriteFile(script, []byte("#!/bin/sh\ntouch \""+marks+"/$1\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	raw := func(args ...string) {
		t.Helper()
		cmd := exec.Command(git, append([]string{"-C", repo}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "HOME="+t.TempDir())
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	raw("init", "-q", "-b", "main")
	raw("config", "user.name", "Test")
	raw("config", "user.email", "test@example.com")
	if err := os.WriteFile(filepath.Join(repo, "a.txt"), []byte("v1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, ".gitattributes"), []byte("*.txt diff=evil\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	raw("add", ".")
	raw("commit", "-q", "-m", "init")
	raw("config", "core.fsmonitor", script+" fsmonitor")
	raw("config", "diff.external", script+" external-diff")
	raw("config", "diff.evil.textconv", script+" textconv")
	raw("config", "core.pager", script+" pager")
	hooks := filepath.Join(repo, ".git", "hooks")
	for _, h := range []string{"post-checkout", "reference-transaction", "pre-commit", "post-commit", "post-merge", "pre-auto-gc", "post-index-change"} {
		if err := os.WriteFile(filepath.Join(hooks, h), []byte("#!/bin/sh\n"+script+" hook-"+h+"\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return repo, marks
}

func noMarks(t *testing.T, marks, after string) {
	t.Helper()
	ents, _ := os.ReadDir(marks)
	for _, e := range ents {
		t.Errorf("after %s, repository config ran a program: %s", after, e.Name())
	}
	for _, e := range ents {
		_ = os.Remove(filepath.Join(marks, e.Name()))
	}
}

// Every git call the harness makes goes through Run: repository-local config and hooks never run a program
// (security review finding 3b; the reviewer's proof was core.fsmonitor run by a worktree creation).
func TestRunIgnoresRepositoryProgramsAndHooks(t *testing.T) {
	ctx := context.Background()
	repo, marks := hostileRepo(t)
	if err := os.WriteFile(filepath.Join(repo, "a.txt"), []byte("v2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !IsRepo(ctx, repo) {
		t.Fatal("not a repository")
	}
	noMarks(t, marks, "rev-parse")
	if _, err := Run(ctx, repo, "status", "--porcelain=v1"); err != nil {
		t.Fatal(err)
	}
	noMarks(t, marks, "status")
	for _, args := range [][]string{{"diff", "HEAD", "--"}, {"log", "-p", "-1"}, {"show", "HEAD"}} {
		if _, err := Run(ctx, repo, args...); err != nil {
			t.Fatal(err)
		}
		noMarks(t, marks, args[0])
	}
	commit, err := HeadCommit(ctx, repo)
	if err != nil {
		t.Fatal(err)
	}
	wt := filepath.Join(t.TempDir(), "wt")
	if err := WorktreeAddBranch(ctx, repo, wt, "octo/x", commit); err != nil {
		t.Fatal(err)
	}
	noMarks(t, marks, "worktree add -b")
	if err := CarryWorkingTreeChanges(ctx, repo, wt); err != nil {
		t.Fatal(err)
	}
	noMarks(t, marks, "carrying working tree changes")
	if b, _ := os.ReadFile(filepath.Join(wt, "a.txt")); string(b) != "v2\n" {
		t.Fatalf("carried a.txt = %q", b)
	}
	det := filepath.Join(t.TempDir(), "det")
	if err := WorktreeAdd(ctx, repo, det, commit); err != nil {
		t.Fatal(err)
	}
	if err := WorktreeCheckout(ctx, det, commit); err != nil {
		t.Fatal(err)
	}
	noMarks(t, marks, "worktree add --detach / checkout")
	if _, err := Run(ctx, repo, "switch", "-c", "other"); err != nil {
		t.Fatal(err)
	}
	if _, err := Run(ctx, repo, "commit", "-q", "-am", "x"); err != nil {
		t.Fatal(err)
	}
	noMarks(t, marks, "switch / commit")
	if err := WorktreeRemove(ctx, repo, wt); err != nil {
		t.Fatal(err)
	}
	noMarks(t, marks, "worktree remove")
	// The child environment carries the same settings, for git processes a git command starts itself.
	cmd := exec.Command("git", "-C", repo, "status")
	cmd.Env = Env()
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	noMarks(t, marks, "plain git with Env()")
}
