package local

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
)

func toolsOver(t *testing.T, roots ...Root) *tools.Registry {
	t.Helper()
	reg := tools.NewRegistry()
	if err := RegisterRoots(reg, roots); err != nil {
		t.Fatal(err)
	}
	return reg
}

func call(t *testing.T, reg *tools.Registry, name string, in map[string]any) (string, bool) {
	t.Helper()
	def, ok := reg.Get(name)
	if !ok {
		t.Fatalf("%s is not registered", name)
	}
	raw, _ := json.Marshal(in)
	out, isErr, err := def.Handle(context.Background(), raw)
	if err != nil {
		t.Fatal(err)
	}
	return out, isErr
}

func put(t *testing.T, root, rel, content string) {
	t.Helper()
	p := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func slurp(t *testing.T, root, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(root, rel))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestEditReplacesExactlyOnce(t *testing.T) {
	root := t.TempDir()
	put(t, root, "a.txt", "alpha\nbeta\ngamma\n")
	reg := toolsOver(t, Root{"main", root})
	out, isErr := call(t, reg, "edit", map[string]any{"path": "a.txt", "old_string": "beta\n", "new_string": "BETA\nbeta2\n"})
	if isErr || slurp(t, root, "a.txt") != "alpha\nBETA\nbeta2\ngamma\n" {
		t.Fatalf("out %q err %v content %q", out, isErr, slurp(t, root, "a.txt"))
	}
}

func TestEditErrors(t *testing.T) {
	root := t.TempDir()
	put(t, root, "a.txt", "x = 1\nx = 1\ny = 2\n")
	put(t, root, "bin.dat", "ab\x00cd")
	reg := toolsOver(t, Root{"main", root})
	for _, tc := range []struct {
		name string
		in   map[string]any
		want string
	}{
		{"no match", map[string]any{"path": "a.txt", "old_string": "z = 9", "new_string": "q"}, "not found"},
		{"two matches", map[string]any{"path": "a.txt", "old_string": "x = 1", "new_string": "x = 2"}, "matches 2 places"},
		{"empty old", map[string]any{"path": "a.txt", "old_string": "", "new_string": "q"}, "must not be empty"},
		{"same", map[string]any{"path": "a.txt", "old_string": "y = 2", "new_string": "y = 2"}, "identical"},
		{"missing file", map[string]any{"path": "nope.txt", "old_string": "a", "new_string": "b"}, "no such file"},
		{"binary", map[string]any{"path": "bin.dat", "old_string": "ab", "new_string": "q"}, "not a text file"},
		{"traversal", map[string]any{"path": "../a.txt", "old_string": "a", "new_string": "b"}, "escapes"},
		{"absolute", map[string]any{"path": filepath.Join(root, "a.txt"), "old_string": "a", "new_string": "b"}, "relative"},
	} {
		out, isErr := call(t, reg, "edit", tc.in)
		if !isErr || !strings.Contains(out, tc.want) {
			t.Errorf("%s: out %q isErr %v, want an error with %q", tc.name, out, isErr, tc.want)
		}
	}
	if got := slurp(t, root, "a.txt"); got != "x = 1\nx = 1\ny = 2\n" {
		t.Fatalf("a failed edit changed the file: %q", got)
	}
	// replace_all handles the non-unique match.
	out, isErr := call(t, reg, "edit", map[string]any{"path": "a.txt", "old_string": "x = 1", "new_string": "x = 2", "replace_all": true})
	if isErr || !strings.Contains(out, "2 replacements") || slurp(t, root, "a.txt") != "x = 2\nx = 2\ny = 2\n" {
		t.Fatalf("replace_all: %q %v %q", out, isErr, slurp(t, root, "a.txt"))
	}
}

func TestEditRefusesASymlinkLeavingTheFolder(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	put(t, outside, "secret.txt", "top secret")
	if err := os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(root, "link.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "dirlink")); err != nil {
		t.Fatal(err)
	}
	reg := toolsOver(t, Root{"main", root})
	for _, p := range []string{"link.txt", "dirlink/secret.txt"} {
		out, isErr := call(t, reg, "edit", map[string]any{"path": p, "old_string": "top", "new_string": "TOP"})
		if !isErr || !strings.Contains(out, "escapes") {
			t.Errorf("%s: %q %v", p, out, isErr)
		}
	}
	if got, _ := os.ReadFile(filepath.Join(outside, "secret.txt")); string(got) != "top secret" {
		t.Fatalf("the file outside the folder was changed: %q", got)
	}
}

func TestEditKeepsFileMode(t *testing.T) {
	root := t.TempDir()
	put(t, root, "run.sh", "echo a\n")
	if err := os.Chmod(filepath.Join(root, "run.sh"), 0o755); err != nil {
		t.Fatal(err)
	}
	reg := toolsOver(t, Root{"main", root})
	if _, isErr := call(t, reg, "edit", map[string]any{"path": "run.sh", "old_string": "a", "new_string": "b"}); isErr {
		t.Fatal("edit failed")
	}
	if fi, _ := os.Stat(filepath.Join(root, "run.sh")); fi.Mode().Perm() != 0o755 {
		t.Fatalf("mode = %v", fi.Mode().Perm())
	}
}

func TestGlobFindsFilesAndSkipsDependencyDirs(t *testing.T) {
	root := t.TempDir()
	for _, p := range []string{"main.go", "pkg/a.go", "pkg/deep/b.go", "pkg/a_test.go", "web/app.tsx", "node_modules/x/index.js", ".git/config", "README.md"} {
		put(t, root, p, "x")
	}
	reg := toolsOver(t, Root{"main", root})
	out, isErr := call(t, reg, "glob", map[string]any{"pattern": "**/*.go"})
	got := strings.Fields(out)
	if isErr || strings.Join(got, ",") != "main.go,pkg/a.go,pkg/a_test.go,pkg/deep/b.go" {
		t.Fatalf("out %q", out)
	}
	out, _ = call(t, reg, "glob", map[string]any{"pattern": "*.go", "path": "pkg"})
	if strings.Join(strings.Fields(out), ",") != "pkg/a.go,pkg/a_test.go" {
		t.Fatalf("path-scoped: %q", out)
	}
	out, _ = call(t, reg, "glob", map[string]any{"pattern": "**/*.{tsx,md}"})
	if strings.Join(strings.Fields(out), ",") != "README.md,web/app.tsx" {
		t.Fatalf("braces: %q", out)
	}
	if out, _ = call(t, reg, "glob", map[string]any{"pattern": "**/*.js"}); out != "no files match" {
		t.Fatalf("node_modules must be skipped: %q", out)
	}
}

func TestGlobRespectsGitignoreInAWorkTree(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := t.TempDir()
	if err := exec.Command("git", "-C", root, "init", "-q").Run(); err != nil {
		t.Skip("git init failed")
	}
	put(t, root, ".gitignore", "build/\n*.log\n")
	put(t, root, "src/a.go", "x")
	put(t, root, "build/out.go", "x")
	put(t, root, "src/debug.log", "x")
	reg := toolsOver(t, Root{"main", root})
	out, _ := call(t, reg, "glob", map[string]any{"pattern": "**/*.{go,log}"})
	if strings.Join(strings.Fields(out), ",") != "src/a.go" {
		t.Fatalf("ignored files listed: %q", out)
	}
}

func TestGlobConfinementAndCap(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	put(t, outside, "o.go", "x")
	if err := os.Symlink(outside, filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 250; i++ {
		put(t, root, "many/f"+strings.Repeat("0", 3-len(itoa(i)))+itoa(i)+".txt", "x")
	}
	reg := toolsOver(t, Root{"main", root})
	for _, tc := range []map[string]any{
		{"pattern": "*.go", "path": "../"},
		{"pattern": "*.go", "path": "link"},
		{"pattern": "../*.go"},
		{"pattern": "/etc/*"},
		{"pattern": "**/../../*"},
	} {
		if out, isErr := call(t, reg, "glob", tc); !isErr {
			t.Errorf("%v must be refused, got %q", tc, out)
		}
	}
	if out, _ := call(t, reg, "glob", map[string]any{"pattern": "**/o.go"}); out != "no files match" {
		t.Fatalf("a symlinked directory must not be followed: %q", out)
	}
	out, _ := call(t, reg, "glob", map[string]any{"pattern": "many/*.txt"})
	if n := len(strings.Split(strings.TrimSpace(out), "\n")); n != 201 || !strings.Contains(out, "stopped at 200 files") {
		t.Fatalf("cap: %d lines, tail %q", n, out[max(len(out)-80, 0):])
	}
}

func itoa(i int) string {
	b, _ := json.Marshal(i)
	return string(b)
}

func TestEditAndGlobInTheMultiFolderSchema(t *testing.T) {
	a, b := t.TempDir(), t.TempDir()
	put(t, b, "f.txt", "one")
	reg := toolsOver(t, Root{"a", a}, Root{"b", b})
	if out, isErr := call(t, reg, "edit", map[string]any{"folder": "b", "path": "f.txt", "old_string": "one", "new_string": "two"}); isErr {
		t.Fatal(out)
	}
	if slurp(t, b, "f.txt") != "two" {
		t.Fatal("edit did not use the folder label")
	}
	if out, _ := call(t, reg, "glob", map[string]any{"folder": "b", "pattern": "*.txt"}); strings.TrimSpace(out) != "f.txt" {
		t.Fatalf("glob in folder b = %q", out)
	}
}
