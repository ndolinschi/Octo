package commands_test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/projcfg"
)

func fmtSscan(s string, n *int) (int, error) { return fmt.Sscan(s, n) }

func write(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestSuggestionsComeFromPackageJsonMakefileAndJustfileAndNothingRuns(t *testing.T) {
	f := newFixture(t, projcfg.Command{Name: "test", Command: "make test"})
	marker := filepath.Join(f.folder, "RAN")
	write(t, f.folder, "package.json", `{"name":"x","version":"1.0.0","scripts":{"dev":"vite","build":"tsc && vite build","test":"touch RAN","bad name; rm -rf /":"x","lint":"eslint ."},"dependencies":{"scripts":"no"}}`)
	write(t, f.folder, "pnpm-lock.yaml", "lockfileVersion: 9\n")
	write(t, f.folder, "Makefile", `CC := gcc
.PHONY: all clean
all: build
	touch RAN
build:
	@echo build
%.o: %.c
	$(CC) -c $<
test: build
	touch RAN
VERSION = 1
deploy:
	touch RAN
`)
	write(t, f.folder, "justfile", `set shell := ["bash", "-c"]
alias b := build
version := "1"

# the default
default: build
  touch RAN

build:
  echo hi

_private:
  echo no

greet name:
  echo {{name}}

serve port="8080":
  echo {{port}}
`)
	libDir := ""
	folders, _ := f.db.Folders(context.Background())
	for _, fo := range folders {
		if fo.Label == "lib" {
			libDir = fo.Path
		}
	}
	write(t, libDir, "package.json", `{"scripts":{"start":"node ."}}`)

	got, err := f.svc.Suggestions(context.Background(), f.pid)
	if err != nil {
		t.Fatal(err)
	}
	var lines []string
	for _, s := range got {
		c := ""
		if s.Configured {
			c = " (configured)"
		}
		lines = append(lines, fmt.Sprintf("%s|%s|%s|%s%s", s.Cwd, s.Source, s.Name, s.Command, c))
	}
	want := []string{
		"app|package.json|dev|pnpm run dev",
		"app|package.json|build|pnpm run build",
		"app|package.json|test|pnpm run test (configured)",
		"app|package.json|lint|pnpm run lint",
		"app|Makefile|all|make all",
		"app|Makefile|build|make build",
		"app|Makefile|test|make test (configured)",
		"app|Makefile|deploy|make deploy",
		"app|justfile|default|just default",
		"app|justfile|build|just build",
		"app|justfile|serve|just serve",
		"lib|package.json|start|npm run start",
	}
	if len(lines) != len(want) {
		t.Fatalf("suggestions:\n%v\nwant\n%v", lines, want)
	}
	for i := range want {
		if lines[i] != want[i] {
			t.Fatalf("suggestion %d = %q, want %q (all: %v)", i, lines[i], want[i], lines)
		}
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("reading the suggestions ran a command")
	}
	if _, err := f.svc.Suggestions(context.Background(), "prj_nope"); err == nil {
		t.Fatal("unknown project")
	}
}

func TestSuggestionsOfAFolderWithNoBuildFilesAreEmpty(t *testing.T) {
	f := newFixture(t)
	got, err := f.svc.Suggestions(context.Background(), f.pid)
	if err != nil || got == nil || len(got) != 0 {
		t.Fatalf("suggestions = %v %v", got, err)
	}
}
