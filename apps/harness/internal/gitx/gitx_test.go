package gitx

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestParsePatchNumbersLinesAndMarksNoNewline(t *testing.T) {
	patch := "diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -3,3 +3,4 @@ func x()\n ctx\n-old\n+new\n+added\n tail\n\\ No newline at end of file\n"
	res := ParsePatch([]byte(patch))
	if len(res.Hunks) != 1 || res.Binary {
		t.Fatalf("res = %+v", res)
	}
	h := res.Hunks[0]
	if h.OldStart != 3 || h.OldLines != 3 || h.NewStart != 3 || h.NewLines != 4 || h.Header != "func x()" {
		t.Fatalf("header = %+v", h)
	}
	want := []Line{
		{Type: "context", Old: 3, New: 3, Text: "ctx"},
		{Type: "del", Old: 4, Text: "old"},
		{Type: "add", New: 4, Text: "new"},
		{Type: "add", New: 5, Text: "added"},
		{Type: "context", Old: 5, New: 6, Text: "tail", NoNewline: true},
	}
	if len(h.Lines) != len(want) {
		t.Fatalf("lines = %+v", h.Lines)
	}
	for i, l := range want {
		if h.Lines[i] != l {
			t.Fatalf("line %d = %+v, want %+v", i, h.Lines[i], l)
		}
	}
}

func TestParsePatchBinary(t *testing.T) {
	res := ParsePatch([]byte("diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n"))
	if !res.Binary || len(res.Hunks) != 0 {
		t.Fatalf("res = %+v", res)
	}
}

func TestParseRawPairsRenames(t *testing.T) {
	raw := ":100644 100644 " + sha('a') + " " + sha('b') + " M\x00dir with space/файл.go\x00" +
		":100644 100644 " + sha('c') + " " + sha('c') + " R100\x00old.go\x00новое.go\x00" +
		":000000 100644 " + zeros() + " " + sha('d') + " A\x00new.txt\x00"
	files, by, err := parseRaw([]byte(raw))
	if err != nil || len(files) != 3 {
		t.Fatalf("files = %+v %v", files, err)
	}
	if files[0].Path != "dir with space/файл.go" || files[0].Status != "modified" {
		t.Fatalf("0 = %+v", files[0])
	}
	if f := files[1]; f.Status != "renamed" || f.OldPath != "old.go" || f.Path != "новое.go" || f.Sim != 100 {
		t.Fatalf("1 = %+v", f)
	}
	if f := files[2]; f.Status != "added" || f.OldBlob != "" || f.NewBlob == "" {
		t.Fatalf("2 = %+v", f)
	}
	if by["новое.go"] != 1 {
		t.Fatalf("index = %v", by)
	}
	nums := parseNumstat([]byte("3\t1\tdir with space/файл.go\x00" + "0\t0\t\x00old.go\x00новое.go\x00" + "-\t-\tlogo.png\x00"))
	if len(nums) != 3 || nums[0].added != 3 || nums[1].path != "новое.go" || !nums[2].binary {
		t.Fatalf("nums = %+v", nums)
	}
}

func TestValidRefName(t *testing.T) {
	for s, want := range map[string]bool{"main": true, "feature/x-1": true, "v1.2.3": true, "": false, "-x": false, "--upload-pack=y": false, "a b": false, "a..b": false, "a\nb": false} {
		if ValidRefName(s) != want {
			t.Errorf("ValidRefName(%q) = %v", s, !want)
		}
	}
}

func TestWorktreeAddBranchAndCarryWorkingTreeChanges(t *testing.T) {
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
	mustGit("init", "-b", "main")
	mustGit("config", "user.name", "Test")
	mustGit("config", "user.email", "test@example.com")
	if err := os.WriteFile(filepath.Join(repo, "tracked.txt"), []byte("v1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustGit("add", "tracked.txt")
	mustGit("commit", "-m", "init")

	branch, err := HeadBranch(ctx, repo)
	if err != nil || branch != "main" {
		t.Fatalf("HeadBranch = %q, %v", branch, err)
	}
	commit, err := HeadCommit(ctx, repo)
	if err != nil || len(commit) < 7 {
		t.Fatalf("HeadCommit = %q, %v", commit, err)
	}

	// Dirty tracked file + untracked file
	if err := os.WriteFile(filepath.Join(repo, "tracked.txt"), []byte("v2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "sub.txt"), []byte("new file\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	wt := filepath.Join(t.TempDir(), "wt")
	if err := WorktreeAddBranch(ctx, repo, wt, "octo/worktree-test", commit); err != nil {
		t.Fatalf("WorktreeAddBranch: %v", err)
	}
	if err := CarryWorkingTreeChanges(ctx, repo, wt); err != nil {
		t.Fatalf("CarryWorkingTreeChanges: %v", err)
	}
	gotTracked, err := os.ReadFile(filepath.Join(wt, "tracked.txt"))
	if err != nil || string(gotTracked) != "v2\n" {
		t.Fatalf("wt tracked.txt = %q, %v", gotTracked, err)
	}
	gotUntracked, err := os.ReadFile(filepath.Join(wt, "sub.txt"))
	if err != nil || string(gotUntracked) != "new file\n" {
		t.Fatalf("wt sub.txt = %q, %v", gotUntracked, err)
	}
	if err := WorktreeRemove(ctx, repo, wt); err != nil {
		t.Fatalf("WorktreeRemove: %v", err)
	}
}

func TestLocalBranchesChunk(t *testing.T) {
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
	commit := func(name, date string) {
		if err := os.WriteFile(filepath.Join(repo, name), []byte(name+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		mustGit("add", name)
		cmd := exec.CommandContext(ctx, "git", "-C", repo, "commit", "-q", "-m", "add "+name)
		cmd.Env = append(os.Environ(), "GIT_COMMITTER_DATE="+date, "GIT_AUTHOR_DATE="+date)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git commit %s: %v\n%s", name, err, out)
		}
	}
	mustGit("init", "-b", "main")
	mustGit("config", "user.name", "Test")
	mustGit("config", "user.email", "test@example.com")
	commit("base.txt", "2026-11-01T10:00:00Z")

	mustGit("checkout", "-q", "-b", "older", "main")
	commit("older.txt", "2026-11-02T10:00:00Z")
	mustGit("checkout", "-q", "-b", "newer", "main")
	commit("newer1.txt", "2026-11-03T10:00:00Z")
	commit("newer2.txt", "2026-11-04T10:00:00Z")
	mustGit("checkout", "-q", "-b", "cur", "main")
	commit("cur.txt", "2026-11-01T12:00:00Z")

	all, trunc, err := LocalBranches(ctx, repo, "main")
	if err != nil || trunc || len(all) != 4 {
		t.Fatalf("LocalBranches = %d trunc=%v err=%v", len(all), trunc, err)
	}
	if all[0].Name != "cur" || !all[0].Current || all[1].Name != "newer" || all[2].Name != "older" || all[3].Name != "main" {
		t.Fatalf("order = %+v", all)
	}

	c1, total, trunc1, err := LocalBranchesChunk(ctx, repo, "main", 0, 2)
	if err != nil || trunc1 || total != 4 || len(c1) != 2 {
		t.Fatalf("chunk1 = %d total=%d trunc=%v err=%v", len(c1), total, trunc1, err)
	}
	if c1[0].Name != "cur" || c1[0].Ahead != 1 || c1[1].Name != "newer" || c1[1].Ahead != 2 {
		t.Fatalf("chunk1 values = %+v", c1)
	}

	c2, total2, _, err := LocalBranchesChunk(ctx, repo, "main", 2, 2)
	if err != nil || total2 != 4 || len(c2) != 2 || c2[0].Name != "older" || c2[0].Ahead != 1 || c2[1].Name != "main" || c2[1].Ahead != 0 {
		t.Fatalf("chunk2 = %+v total=%d err=%v", c2, total2, err)
	}

	empty, total3, _, err := LocalBranchesChunk(ctx, repo, "main", 10, 2)
	if err != nil || total3 != 4 || len(empty) != 0 {
		t.Fatalf("beyond = %+v total=%d err=%v", empty, total3, err)
	}
}

func sha(c byte) string {
	b := make([]byte, 40)
	for i := range b {
		b[i] = c
	}
	return string(b)
}

func zeros() string { return sha('0') }
