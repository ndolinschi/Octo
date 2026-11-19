package files_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/files"
)

func mkdirs(t *testing.T, root string, dirs ...string) {
	t.Helper()
	for _, d := range dirs {
		if err := os.MkdirAll(filepath.Join(root, filepath.FromSlash(d)), 0o755); err != nil {
			t.Fatal(err)
		}
	}
}

func touch(t *testing.T, root string, paths ...string) {
	t.Helper()
	for _, p := range paths {
		if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(p)), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func chains(t *testing.T, root, rel string) map[string]string {
	t.Helper()
	got, err := files.List(root, rel)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for _, e := range got {
		if e.Type == "dir" {
			out[e.Name] = strings.Join(e.Chain, "/")
		} else if e.Chain != nil {
			t.Fatalf("file %s has a chain %v", e.Path, e.Chain)
		}
	}
	return out
}

func TestListChain(t *testing.T) {
	root := t.TempDir()
	// The owner's screenshot: a Maven module whose package directories each hold one directory.
	pkg := "app/src/main/java/com/wsgc/ecommerce/product/configurator/management/data/subsystem"
	mkdirs(t, root, pkg+"/config", pkg+"/mdm", "app/src/test/java/com/wsgc", "lone/leaf", "two/a", "two/b", "withfile/sub/x", "empty", "gitonly/only/.git", "gitonly/only/inner")
	touch(t, root, "app/pom.xml", pkg+"/Main.java", "withfile/sub/readme.md")
	if err := os.Symlink(filepath.Join(root, "two"), filepath.Join(root, "linkdir")); err != nil {
		t.Fatal(err)
	}
	mkdirs(t, root, "vialink")
	if err := os.Symlink(filepath.Join(root, "two"), filepath.Join(root, "vialink", "to")); err != nil {
		t.Fatal(err)
	}

	top := chains(t, root, "")
	want := map[string]string{
		"app":      "",           // a file (pom.xml) and a directory: not a chain
		"lone":     "leaf",       // a chain ending in an empty leaf directory
		"two":      "",           // two child directories
		"withfile": "sub",        // sub holds a file and a directory: the chain ends at sub
		"empty":    "",           // nothing inside
		"gitonly":  "only/inner", // .git is not an entry: only/ holds just inner, an empty leaf
		"linkdir":  "",           // a symlinked directory is never descended
		"vialink":  "",           // its only child is a symlink: the chain stops before it
	}
	for k, v := range want {
		if top[k] != v {
			t.Errorf("chain of %s = %q, want %q", k, top[k], v)
		}
	}

	src := chains(t, root, "app")
	if got := src["src"]; got != "" {
		t.Errorf("app/src has main and test: chain %q, want none", got)
	}
	main := chains(t, root, "app/src")
	if got := main["main"]; got != "java/com/wsgc/ecommerce/product/configurator/management/data/subsystem" {
		t.Errorf("chain of app/src/main = %q", got)
	}
	if got := main["test"]; got != "java/com/wsgc" {
		t.Errorf("chain of app/src/test = %q (ends in an empty leaf)", got)
	}
}

func TestListChainCap(t *testing.T) {
	root := t.TempDir()
	parts := make([]string, files.MaxChain+5)
	for i := range parts {
		parts[i] = "d"
	}
	mkdirs(t, root, "top/"+strings.Join(parts, "/"))
	got, err := files.List(root, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || len(got[0].Chain) != files.MaxChain {
		t.Fatalf("chain length = %d, want the cap %d", len(got[0].Chain), files.MaxChain)
	}
}
