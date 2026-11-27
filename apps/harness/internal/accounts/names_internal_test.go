package accounts

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
)

func TestSlugOf(t *testing.T) {
	for name, want := range map[string]string{
		"Work":                         "work",
		"My  Work / Team":              "my-work-team",
		"--x--":                        "x",
		"Ünïcode":                      "n-code",
		"!!!":                          "account",
		strings.Repeat("ab", 30):       strings.Repeat("ab", 16),
		strings.Repeat("a", 31) + " b": strings.Repeat("a", 31),
	} {
		got := slugOf(name)
		if got != want || !plugins.ValidSlug(got) {
			t.Errorf("slugOf(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestNewSlugSuffixStaysValid(t *testing.T) {
	s := &Service{root: t.TempDir()}
	long := strings.Repeat("a", 32)
	s.f.Accounts = []Account{{Agent: "cc", ID: long}}
	if got, err := s.newSlug("cc", long); err != nil || got != strings.Repeat("a", 30)+"-2" || !plugins.ValidSlug(got) {
		t.Fatalf("newSlug = %q, %v", got, err)
	}
}

// A folder that cannot be examined (here the agent's folder is a file, so the
// Lstat says "not a directory") ends the search with an error.
func TestNewSlugFailsOnAnUnreadableFolder(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "cc"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := &Service{root: root}
	done := make(chan error, 1)
	go func() { _, err := s.newSlug("cc", "Work"); done <- err }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("want an error")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("newSlug did not return")
	}
}
