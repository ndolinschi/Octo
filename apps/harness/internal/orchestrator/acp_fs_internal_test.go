package orchestrator

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

func intp(n int) *int { return &n }

func TestSliceLines(t *testing.T) {
	const text = "one\ntwo\nthree\nfour\n"
	for _, tc := range []struct {
		name        string
		line, limit *int
		want        string
	}{
		{"whole file", nil, nil, text},
		{"from line 2", intp(2), nil, "two\nthree\nfour\n"},
		{"line 0 is the start", intp(0), intp(1), "one\n"},
		{"limit only", nil, intp(2), "one\ntwo\n"},
		{"middle window", intp(2), intp(2), "two\nthree\n"},
		{"limit zero", intp(1), intp(0), ""},
		{"past the end", intp(9), nil, ""},
		{"limit beyond end", intp(4), intp(10), "four\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := sliceLines(text, tc.line, tc.limit); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
	if got := sliceLines("a\nb", intp(2), nil); got != "b" {
		t.Fatalf("no trailing newline: %q", got)
	}
}

func TestLocateConfinement(t *testing.T) {
	base := t.TempDir()
	real := filepath.Join(base, "real")
	sibling := filepath.Join(base, "real-sibling")
	link := filepath.Join(base, "link")
	for _, d := range []string{real, sibling} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	rt := &runtime{folders: []projectstore.Folder{{Label: "src", Path: real}, {Label: "viaLink", Path: link}}}
	for _, tc := range []struct {
		name, path, label, rel string
		wantErr                string
	}{
		{"file in root", filepath.Join(real, "a.txt"), "src", "a.txt", ""},
		{"nested", filepath.Join(real, "d", "e.go"), "src", "d/e.go", ""},
		{"dotdot that stays inside", real + "/d/../a.txt", "src", "a.txt", ""},
		{"dotdot escape", real + "/../real-sibling/x", "", "", "outside the project folders"},
		{"sibling with shared prefix", filepath.Join(sibling, "x"), "", "", "outside the project folders"},
		{"outside", "/etc/hostname", "", "", "outside the project folders"},
		{"relative", "a.txt", "", "", "must be absolute"},
		{"folder root itself", real, "", "", "folder root"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, label, rel, err := rt.locate(tc.path)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("err = %v, want %q", err, tc.wantErr)
				}
				return
			}
			if err != nil || label != tc.label || rel != tc.rel {
				t.Fatalf("got %q %q %v, want %q %q", label, rel, err, tc.label, tc.rel)
			}
		})
	}
}

func TestACPFilesRefuseSymlinkEscape(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("s"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "door")); err != nil {
		t.Fatal(err)
	}
	s := &acpSession{rt: &runtime{folders: []projectstore.Folder{{Label: "p", Path: root}}}, label: "t"}
	if _, err := s.ReadTextFile(context.Background(), acp.ReadTextFileParams{Path: filepath.Join(root, "door", "secret.txt")}); err == nil {
		t.Error("read through an escaping symlink succeeded")
	}
	if err := s.WriteTextFile(context.Background(), acp.WriteTextFileParams{Path: filepath.Join(root, "door", "new", "x.txt"), Content: "x"}); err == nil {
		t.Error("write through an escaping symlink succeeded")
	}
	if _, err := os.Stat(filepath.Join(outside, "new")); err == nil {
		t.Error("directory was created outside the root")
	}
}
