package local

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
)

// Writes into .git (config, hooks, the .git file of a worktree or submodule) would let a file write become code
// the harness's own git calls run (core.fsmonitor, hooks): every write path refuses them; reads stay allowed
// (security review finding 3a).
func TestResolveWritableRefusesGitPaths(t *testing.T) {
	root := t.TempDir()
	for _, d := range []string{".git/hooks", "sub/.git", "src"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, ".git/config"), []byte("[core]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "wt"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "wt/.git"), []byte("gitdir: ../.git/worktrees/wt\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(".git", filepath.Join(root, "innocent")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(".git/config", filepath.Join(root, "cfg")); err != nil {
		t.Fatal(err)
	}
	for _, rel := range []string{
		".git", ".git/config", ".git/hooks/pre-commit", ".GIT/config", ".Git/hooks/post-checkout", "sub/.git/config",
		"wt/.git", "innocent/config", "innocent/hooks/pre-commit", "cfg", "src/../.git/config", "./.git/config",
	} {
		if _, err := ResolveWritable(root, rel); !errors.Is(err, ErrGitPath) {
			t.Errorf("ResolveWritable(%q) = %v, want ErrGitPath", rel, err)
		}
		if _, err := Resolve(root, rel); err != nil {
			t.Errorf("reading %q is refused: %v", rel, err)
		}
	}
	for _, rel := range []string{".gitignore", ".github/workflows/ci.yml", "src/a.git", "foo.git/x", ".gitmodules", "src/new.txt"} {
		if _, err := ResolveWritable(root, rel); err != nil {
			t.Errorf("ResolveWritable(%q) = %v, want allowed", rel, err)
		}
	}

	reg := tools.NewRegistry()
	if err := Register(reg, root); err != nil {
		t.Fatal(err)
	}
	write, _ := reg.Get("write_file")
	edit, _ := reg.Get("edit")
	for _, p := range []string{".git/config", "innocent/config", "sub/.git/config"} {
		if out, isErr, _ := write.Handle(context.Background(), json.RawMessage(`{"path":"`+p+`","content":"[core]\n\tfsmonitor = touch pwned\n"}`)); !isErr {
			t.Errorf("write_file %s succeeded: %s", p, out)
		}
	}
	if out, isErr, _ := edit.Handle(context.Background(), json.RawMessage(`{"path":".git/config","old_string":"[core]","new_string":"[core]\n\tfsmonitor = touch pwned"}`)); !isErr {
		t.Errorf("edit .git/config succeeded: %s", out)
	}
	if b, _ := os.ReadFile(filepath.Join(root, ".git/config")); string(b) != "[core]\n" {
		t.Fatalf(".git/config changed: %q", b)
	}
	read, _ := reg.Get("read_file")
	if out, isErr, _ := read.Handle(context.Background(), json.RawMessage(`{"path":".git/config"}`)); isErr {
		t.Errorf("read_file .git/config refused: %s", out)
	}
}
