package files

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestMkdirRenameDelete(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}

	got, err := Mkdir(root, "src/nested")
	if err != nil || got != "src/nested" {
		t.Fatalf("Mkdir: got (%q, %v)", got, err)
	}
	if _, err := Write(root, "src/nested/hello.txt", "hello world\nsecond line\n", nil); err != nil {
		t.Fatalf("Write: %v", err)
	}

	moved, err := Rename(root, "src/nested/hello.txt", "src/nested/greet.txt")
	if err != nil || moved != "src/nested/greet.txt" {
		t.Fatalf("Rename: got (%q, %v)", moved, err)
	}
	if _, err := Rename(root, "src/nested/greet.txt", "src/nested/greet.txt"); err != nil {
		t.Fatalf("Rename same path: %v", err)
	}

	// Security boundaries: .git, root delete, traversal refused
	if _, err := Mkdir(root, ".git/hooks"); !errors.Is(err, ErrGitPath) {
		t.Fatalf("Mkdir .git expected ErrGitPath, got %v", err)
	}
	if _, err := Delete(root, ""); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("Delete root expected ErrInvalidPath, got %v", err)
	}
	if _, err := Delete(root, "../outside"); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("Delete traversal expected ErrInvalidPath, got %v", err)
	}
	if _, err := Rename(root, "src/nested/greet.txt", ".git/config"); !errors.Is(err, ErrGitPath) {
		t.Fatalf("Rename into .git expected ErrGitPath, got %v", err)
	}

	// Delete file and folder
	if _, err := Delete(root, "src/nested/greet.txt"); err != nil {
		t.Fatalf("Delete file: %v", err)
	}
	if _, err := Delete(root, "src"); err != nil {
		t.Fatalf("Delete dir: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "src")); !os.IsNotExist(err) {
		t.Fatalf("expected src to be deleted, err=%v", err)
	}
}

func TestSearchNameAndContent(t *testing.T) {
	root := t.TempDir()
	for _, rel := range []string{"src/auth.go", "src/retry.go", "README.md", "node_modules/pkg/index.js", ".git/HEAD"} {
		full := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		content := "package main\n// retry transient 5xx errors\n"
		if rel == "src/auth.go" {
			content = "package auth\nfunc VerifyToken() bool { return true }\n"
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	byName, err := Search(root, "auth", "name", 20)
	if err != nil {
		t.Fatalf("Search name: %v", err)
	}
	if len(byName) != 1 || byName[0].Path != "src/auth.go" {
		t.Fatalf("unexpected name matches: %+v", byName)
	}

	// node_modules and .git must be skipped
	allNames, err := Search(root, "", "name", 20)
	if err != nil {
		t.Fatalf("Search empty name: %v", err)
	}
	for _, m := range allNames {
		if m.Path == "node_modules/pkg/index.js" || m.Path == ".git/HEAD" {
			t.Fatalf("expected skipped dir match to be excluded: %+v", m)
		}
	}

	byContent, err := Search(root, "VerifyToken", "content", 20)
	if err != nil {
		t.Fatalf("Search content: %v", err)
	}
	if len(byContent) != 1 || byContent[0].Path != "src/auth.go" || byContent[0].Line != 2 {
		t.Fatalf("unexpected content matches: %+v", byContent)
	}
}
