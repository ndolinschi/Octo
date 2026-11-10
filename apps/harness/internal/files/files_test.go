package files_test

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/files"
)

func tree(t *testing.T) (root, outside string) {
	t.Helper()
	root, outside = t.TempDir(), t.TempDir()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.MkdirAll(filepath.Join(root, "src", "deep"), 0o755))
	must(os.MkdirAll(filepath.Join(root, ".git"), 0o755))
	must(os.MkdirAll(filepath.Join(root, "alpha"), 0o755))
	must(os.WriteFile(filepath.Join(root, "b.txt"), []byte("bee"), 0o644))
	must(os.WriteFile(filepath.Join(root, "a.txt"), []byte("ay"), 0o644))
	must(os.WriteFile(filepath.Join(root, "src", "main.go"), []byte("package main\n"), 0o644))
	must(os.WriteFile(filepath.Join(root, "src", ".git"), []byte("gitfile"), 0o644))
	must(os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("secret"), 0o644))
	must(os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(root, "link.txt")))
	must(os.Symlink(outside, filepath.Join(root, "outdir")))
	return root, outside
}

func TestListSortingAndGit(t *testing.T) {
	root, _ := tree(t)
	got, err := files.List(root, "")
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range got {
		names = append(names, e.Type+":"+e.Name)
	}
	want := "dir:alpha,dir:outdir,dir:src,file:a.txt,file:b.txt,file:link.txt"
	if strings.Join(names, ",") != want {
		t.Fatalf("entries = %v, want %s", names, want)
	}
	sub, err := files.List(root, "src")
	if err != nil {
		t.Fatal(err)
	}
	if len(sub) != 2 || sub[0].Path != "src/deep" || sub[1].Path != "src/main.go" || sub[1].Size != 13 {
		t.Fatalf("src entries = %+v", sub)
	}
}

func TestConfinementAndErrors(t *testing.T) {
	root, outside := tree(t)
	for _, tc := range []struct {
		name string
		path string
		want error
	}{
		{"dotdot", "../x", files.ErrInvalidPath},
		{"nested dotdot", "src/../../x", files.ErrInvalidPath},
		{"absolute", outside, files.ErrInvalidPath},
		{"file symlink escape", "link.txt", files.ErrInvalidPath},
		{"dir symlink escape", "outdir", files.ErrInvalidPath},
		{"through dir symlink", "outdir/secret.txt", files.ErrInvalidPath},
		{"missing", "nope.txt", files.ErrNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, _, err := files.Read(root, tc.path); !errors.Is(err, tc.want) {
				t.Errorf("Read err = %v, want %v", err, tc.want)
			}
			if _, err := files.List(root, tc.path); !errors.Is(err, tc.want) {
				t.Errorf("List err = %v, want %v", err, tc.want)
			}
			if tc.want == files.ErrInvalidPath {
				if _, err := files.Write(root, tc.path, "x", nil); !errors.Is(err, tc.want) {
					t.Errorf("Write err = %v, want %v", err, tc.want)
				}
			}
		})
	}
	if _, err := files.List(root, "a.txt"); !errors.Is(err, files.ErrNotFound) {
		t.Errorf("List on file = %v", err)
	}
	if _, _, err := files.Read(root, "src"); !errors.Is(err, files.ErrNotFile) {
		t.Errorf("Read dir = %v", err)
	}
	if b, _ := os.ReadFile(filepath.Join(outside, "secret.txt")); string(b) != "secret" {
		t.Errorf("outside file modified: %q", b)
	}
}

func TestReadLimits(t *testing.T) {
	root := t.TempDir()
	write := func(name string, data []byte) {
		if err := os.WriteFile(filepath.Join(root, name), data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("ok.txt", []byte("héllo"))
	write("max.txt", []byte(strings.Repeat("a", files.MaxReadBytes)))
	write("big.txt", []byte(strings.Repeat("a", files.MaxReadBytes+1)))
	write("nul.bin", []byte("ab\x00cd"))
	write("bad.txt", []byte{0xff, 0xfe, 'a'})
	for name, want := range map[string]error{
		"ok.txt": nil, "max.txt": nil, "big.txt": files.ErrTooLarge, "nul.bin": files.ErrBinary, "bad.txt": files.ErrBinary,
	} {
		text, info, err := files.Read(root, name)
		if !errors.Is(err, want) || (want == nil && (text == "" || info.Path != name || info.MTime.IsZero())) {
			t.Errorf("%s: err = %v, want %v", name, err, want)
		}
	}
}

func TestWrite(t *testing.T) {
	root, _ := tree(t)
	info, err := files.Write(root, "new.txt", "hello", nil)
	if err != nil || info.Path != "new.txt" || info.Size != 5 {
		t.Fatalf("create = %+v, %v", info, err)
	}
	if fi, _ := os.Stat(filepath.Join(root, "new.txt")); fi.Mode().Perm() != 0o644 {
		t.Errorf("new file mode = %v", fi.Mode().Perm())
	}
	if _, err := files.Write(root, "missing/new.txt", "x", nil); !errors.Is(err, files.ErrNotFound) {
		t.Errorf("missing parent = %v", err)
	}
	if _, err := files.Write(root, "src", "x", nil); !errors.Is(err, files.ErrNotFile) {
		t.Errorf("write over dir = %v", err)
	}
	stale := info.MTime.Add(-time.Second)
	if _, err := files.Write(root, "new.txt", "x", &stale); !errors.Is(err, files.ErrChanged) {
		t.Errorf("stale mtime = %v", err)
	}
	if _, err := files.Write(root, "ghost.txt", "x", &info.MTime); !errors.Is(err, files.ErrChanged) {
		t.Errorf("missing file with expected = %v", err)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "new.txt")); string(b) != "hello" {
		t.Errorf("content after refused writes = %q", b)
	}
	next, err := files.Write(root, "new.txt", "world!", &info.MTime)
	if err != nil || next.Size != 6 {
		t.Fatalf("guarded overwrite = %+v, %v", next, err)
	}
}

func TestWriteKeepsModeAndLeavesNoTemp(t *testing.T) {
	root := t.TempDir()
	p := filepath.Join(root, "run.sh")
	if err := os.WriteFile(p, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := files.Write(root, "run.sh", "new", nil); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(p)
	if err != nil || fi.Mode().Perm() != 0o755 {
		t.Fatalf("mode = %v, %v", fi.Mode().Perm(), err)
	}
	if b, _ := os.ReadFile(p); string(b) != "new" {
		t.Fatalf("content = %q", b)
	}
	entries, _ := os.ReadDir(root)
	if len(entries) != 1 {
		t.Fatalf("leftover files: %v", entries)
	}
}
