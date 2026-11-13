package changes

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

func newTracker(t *testing.T, dir string) (*Tracker, *projectstore.DB, []Folder) {
	t.Helper()
	store, err := projectstore.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	db, err := store.Create(context.Background(), projectstore.NewProject{
		Name: "p", ModelsJSON: "{}", MaxDepth: 1, OrchestratorModel: "m",
		Folders: []projectstore.Folder{{Label: "ws", Path: dir}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return NewTracker(db), db, []Folder{{Label: "ws", Path: dir}}
}

func write(t *testing.T, root, rel, content string) {
	t.Helper()
	p := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func byPath(list []projectstore.Change) map[string]projectstore.Change {
	m := map[string]projectstore.Change{}
	for _, c := range list {
		m[c.Path] = c
	}
	return m
}

func TestSnapshotDetectsBashStyleChanges(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	write(t, dir, "a.txt", "one\ntwo\nthree\n")
	write(t, dir, "gone.txt", "bye\n")
	write(t, dir, "node_modules/x/index.js", "skipped\n")
	tr, db, folders := newTracker(t, dir)

	tr.Begin(ctx, folders)
	write(t, dir, "a.txt", "one\nTWO\nthree\nfour\n")
	write(t, dir, "new/b.txt", "hello\n")
	write(t, dir, "bin.dat", "a\x00b")
	write(t, dir, "node_modules/x/index.js", "still skipped\n")
	if err := os.Remove(filepath.Join(dir, "gone.txt")); err != nil {
		t.Fatal(err)
	}
	got := byPath(tr.End(ctx, folders, Scope{TurnID: 7, AgentID: "ag", ToolUseID: "tu1", Source: SourceBash}))

	if len(got) != 4 {
		t.Fatalf("want 4 changes, got %d: %+v", len(got), got)
	}
	a := got["a.txt"]
	if a.Kind != projectstore.ChangeModified || *a.Added != 2 || *a.Removed != 1 || a.TurnID != 7 || a.Source != SourceBash || a.ToolUseID != "tu1" {
		t.Errorf("a.txt: %+v", a)
	}
	if b := got["new/b.txt"]; b.Kind != projectstore.ChangeCreated || *b.Added != 1 || b.BeforeHash != nil {
		t.Errorf("new/b.txt: %+v", b)
	}
	if g := got["gone.txt"]; g.Kind != projectstore.ChangeDeleted || *g.Removed != 1 || g.AfterHash != nil {
		t.Errorf("gone.txt: %+v", g)
	}
	if bin := got["bin.dat"]; bin.Note != projectstore.NoteBinary || bin.Added != nil {
		t.Errorf("bin.dat: %+v", bin)
	}
	// Blobs: before of a.txt is the original.
	if s, ok, _ := db.Blob(ctx, *a.BeforeHash); !ok || s != "one\ntwo\nthree\n" {
		t.Errorf("before blob %q %v", s, ok)
	}
	// A second window sees nothing new.
	tr.Begin(ctx, folders)
	if more := tr.End(ctx, folders, Scope{TurnID: 7, Source: SourceBash}); len(more) != 0 {
		t.Errorf("unexpected changes: %+v", more)
	}
}

func TestBeginAbsorbsEditsBetweenCalls(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	write(t, dir, "f.txt", "x\n")
	tr, _, folders := newTracker(t, dir)
	tr.Begin(ctx, folders)
	tr.End(ctx, folders, Scope{})
	write(t, dir, "f.txt", "edited by the user\n")
	tr.Begin(ctx, folders)
	if got := tr.End(ctx, folders, Scope{}); len(got) != 0 {
		t.Fatalf("a user edit before the call was attributed to it: %+v", got)
	}
}

func TestOverlappingWindowsRecordOnce(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	write(t, dir, "f.txt", "x\n")
	tr, _, folders := newTracker(t, dir)
	tr.Begin(ctx, folders)
	tr.Begin(ctx, folders)
	write(t, dir, "f.txt", "y\n")
	n := len(tr.End(ctx, folders, Scope{AgentID: "a"})) + len(tr.End(ctx, folders, Scope{AgentID: "b"}))
	if n != 1 {
		t.Fatalf("the change was recorded %d times", n)
	}
}

func TestExplicitWriteIsNotCountedAgain(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	write(t, dir, "w.txt", "a\n")
	tr, _, folders := newTracker(t, dir)
	tr.Begin(ctx, folders)
	abs := filepath.Join(dir, "w.txt")
	before := tr.PreWrite(abs)
	write(t, dir, "w.txt", "a\nb\n")
	c, ok := tr.PostWrite(ctx, Scope{TurnID: 1, Source: SourceWriteFile}, folders[0], "w.txt", before)
	if !ok || *c.Added != 1 || *c.Removed != 0 {
		t.Fatalf("explicit write: %+v %v", c, ok)
	}
	if more := tr.End(ctx, folders, Scope{TurnID: 1, Source: SourceBash}); len(more) != 0 {
		t.Fatalf("snapshot counted the explicit write again: %+v", more)
	}
}

func TestGitignoreRespected(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	ctx := context.Background()
	dir := t.TempDir()
	run := func(args ...string) {
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	run("init", "-q")
	write(t, dir, ".gitignore", "out/\n*.log\n")
	write(t, dir, "src.go", "package x\n")
	tr, _, folders := newTracker(t, dir)
	tr.Begin(ctx, folders)
	write(t, dir, "out/artifact.bin", "ignored")
	write(t, dir, "run.log", "ignored")
	write(t, dir, "src.go", "package y\n")
	write(t, dir, "fresh.go", "package z\n")
	got := byPath(tr.End(ctx, folders, Scope{Source: SourceBash}))
	if len(got) != 2 || got["src.go"].Path == "" || got["fresh.go"].Path == "" {
		t.Fatalf("got %+v", got)
	}
	for p := range got {
		if strings.HasPrefix(p, "out/") || strings.HasSuffix(p, ".log") {
			t.Errorf("ignored path recorded: %s", p)
		}
	}
}

func TestLargeFileHasNoPreimage(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	write(t, dir, "big.txt", strings.Repeat("line\n", MaxShadowFile/5+10))
	tr, _, folders := newTracker(t, dir)
	tr.Begin(ctx, folders)
	write(t, dir, "big.txt", strings.Repeat("line\n", MaxShadowFile/5+20))
	got := tr.End(ctx, folders, Scope{Source: SourceBash})
	if len(got) != 1 || got[0].Note != projectstore.NoteTooLarge || got[0].Added != nil {
		t.Fatalf("got %+v", got)
	}
}
