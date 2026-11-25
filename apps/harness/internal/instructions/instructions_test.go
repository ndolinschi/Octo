package instructions

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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

func paths(s Set) []string {
	var out []string
	for _, f := range s.Files {
		out = append(out, f.Path)
	}
	return out
}

func TestRootFilesAndNearestLast(t *testing.T) {
	root := t.TempDir()
	write(t, root, "AGENTS.md", "root rule\n")
	write(t, root, "CLAUDE.md", "root claude rule\n")
	write(t, root, "pkg/AGENTS.md", "pkg rule\n")
	write(t, root, "pkg/deep/AGENTS.md", "deep rule\n")
	write(t, root, "other/AGENTS.md", "other rule\n")
	fs := []Folder{{Label: "main", Path: root}}

	got := paths(Collect(fs, nil))
	if strings.Join(got, ",") != "main:AGENTS.md,main:CLAUDE.md" {
		t.Fatalf("root only = %v", got)
	}
	got = paths(Collect(fs, []string{"pkg/deep/x.go"}))
	if strings.Join(got, ",") != "main:AGENTS.md,main:CLAUDE.md,main:pkg/AGENTS.md,main:pkg/deep/AGENTS.md" {
		t.Fatalf("with a deep path = %v (the nearest directory must come last, other/ must not appear)", got)
	}
	abs := filepath.Join(root, "pkg", "deep", "x.go")
	if got2 := paths(Collect(fs, []string{abs})); strings.Join(got2, ",") != strings.Join(got, ",") {
		t.Fatalf("absolute path = %v, want %v", got2, got)
	}
	if got3 := paths(Collect(fs, []string{"../outside/x.go"})); len(got3) != 2 {
		t.Fatalf("a path outside the folder must add nothing: %v", got3)
	}
}

func TestReadFreshEachCall(t *testing.T) {
	root := t.TempDir()
	write(t, root, "AGENTS.md", "v1")
	fs := []Folder{{Label: "m", Path: root}}
	if r := Collect(fs, nil).Render(nil); !strings.Contains(r, "v1") {
		t.Fatalf("render = %q", r)
	}
	write(t, root, "AGENTS.md", "v2")
	if r := Collect(fs, nil).Render(nil); !strings.Contains(r, "v2") || strings.Contains(r, "v1") {
		t.Fatalf("a change is picked up on the next call: %q", r)
	}
}

func TestBigFileIsTruncatedWithMarker(t *testing.T) {
	root := t.TempDir()
	write(t, root, "AGENTS.md", "head rule\n"+strings.Repeat("x", 200_000))
	set := Collect([]Folder{{Label: "m", Path: root}}, nil)
	if len(set.Files) != 1 {
		t.Fatalf("files = %+v", set.Files)
	}
	f := set.Files[0]
	if !f.Truncated || f.Size < 200_000 || f.Used > MaxFile {
		t.Fatalf("file = %+v", f)
	}
	r := set.Render(nil)
	if !strings.Contains(r, "head rule") || !strings.Contains(r, "truncated by the harness") || len(r) > MaxFile+2048 {
		t.Fatalf("render len %d, marker present %v", len(r), strings.Contains(r, "truncated by the harness"))
	}
}

func TestTotalCapKeepsTheNearestFiles(t *testing.T) {
	root := t.TempDir()
	big := strings.Repeat("a", 30_000)
	write(t, root, "AGENTS.md", "ROOT "+big)
	write(t, root, "CLAUDE.md", "CLAUDE "+big)
	write(t, root, "a/AGENTS.md", "A "+big)
	write(t, root, "a/b/AGENTS.md", "NEAR "+big)
	set := Collect([]Folder{{Label: "m", Path: root}}, []string{"a/b/x"})
	total := 0
	for _, f := range set.Files {
		total += len(f.text)
	}
	if total > MaxTotal {
		t.Fatalf("total %d exceeds %d", total, MaxTotal)
	}
	last := set.Files[len(set.Files)-1]
	if last.Path != "m:a/b/AGENTS.md" || last.Truncated {
		t.Fatalf("the nearest file must be kept whole and last: %+v", last)
	}
}

func TestRedactAndSymlinkEscape(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	write(t, outside, "secret.md", "leaked")
	write(t, root, "CLAUDE.md", "token is s3cr3t-value")
	if err := os.Symlink(filepath.Join(outside, "secret.md"), filepath.Join(root, "AGENTS.md")); err != nil {
		t.Fatal(err)
	}
	set := Collect([]Folder{{Label: "m", Path: root}}, nil)
	if got := paths(set); len(got) != 1 || got[0] != "m:CLAUDE.md" {
		t.Fatalf("a symlink leaving the folder must be skipped: %v", got)
	}
	r := set.Render(func(s string) string { return strings.ReplaceAll(s, "s3cr3t-value", "[secret]") })
	if strings.Contains(r, "s3cr3t") || !strings.Contains(r, "[secret]") {
		t.Fatalf("render = %q", r)
	}
}

func TestPathsIn(t *testing.T) {
	root := t.TempDir()
	write(t, root, "src/app/main.go", "x")
	fs := []Folder{{Label: "m", Path: root}}
	got := PathsIn(fs, "Please fix `src/app/main.go:12`, and see https://example.com/a.b and nothing/there.go.")
	if len(got) != 1 || got[0] != "src/app/main.go" {
		t.Fatalf("paths = %v", got)
	}
	if got := PathsIn(fs, "open "+filepath.Join(root, "src")); len(got) != 1 {
		t.Fatalf("absolute directory = %v", got)
	}
}
