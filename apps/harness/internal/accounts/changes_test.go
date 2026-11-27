package accounts_test

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/accounts"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
)

func TestOwnedOnlyWhenOctoCreatesTheFolder(t *testing.T) {
	s := accounts.Open(t.TempDir())
	created, err := s.Add(claude, plugins.Account{Label: "New", ConfigDir: filepath.Join(t.TempDir(), "new")})
	if err != nil || !created.Owned {
		t.Fatalf("new folder: %+v %v", created, err)
	}
	existing := t.TempDir()
	kept, err := s.Add(claude, plugins.Account{Label: "Mine", ConfigDir: existing})
	if err != nil || kept.Owned {
		t.Fatalf("existing folder: %+v %v", kept, err)
	}
}

// A folder named through a symlink is the same login as the folder itself.
func TestSameFolderThroughASymlinkIsTaken(t *testing.T) {
	s := accounts.Open("")
	real := filepath.Join(t.TempDir(), "real")
	if _, err := s.Add(claude, plugins.Account{Label: "A", ConfigDir: real}); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(real, link); err != nil {
		t.Skip("no symlinks:", err)
	}
	if _, err := s.Add(claude, plugins.Account{Label: "B", ConfigDir: link}); !errors.Is(err, accounts.ErrTaken) {
		t.Fatalf("err = %v", err)
	}
}

func TestRenameAndDefaultLabel(t *testing.T) {
	data := t.TempDir()
	s := accounts.Open(data)
	a, err := s.Add(claude, plugins.Account{Label: "Work", ConfigDir: filepath.Join(t.TempDir(), "w")})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Add(claude, plugins.Account{Label: "Other", ConfigDir: filepath.Join(t.TempDir(), "o")}); err != nil {
		t.Fatal(err)
	}
	got, err := s.Rename(claude, a.ID, " Day job ")
	if err != nil || got.ID != a.ID || got.Label != "Day job" || got.ConfigDir != a.ConfigDir {
		t.Fatalf("rename = %+v %v", got, err)
	}
	if _, err := s.Rename(claude, "", "Personal"); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		name       string
		agent      plugins.Agent
		id, label  string
		wantTarget error
	}{
		{"another account's", claude, a.ID, "other", accounts.ErrTaken},
		{"the default's", claude, a.ID, "PERSONAL", accounts.ErrTaken},
		{"unknown", claude, "nope", "X", accounts.ErrNotFound},
		{"no accounts", plugins.Agent{ID: "grok"}, "", "X", accounts.ErrNotSupported},
	} {
		if _, err := s.Rename(c.agent, c.id, c.label); !errors.Is(err, c.wantTarget) {
			t.Errorf("%s: err = %v", c.name, err)
		}
	}
	var inv *accounts.InvalidError
	if _, err := s.Rename(claude, a.ID, " "); !errors.As(err, &inv) || inv.Field != "label" {
		t.Fatalf("empty label: %v", err)
	}
	re := accounts.Open(data)
	if l := re.DefaultLabels()["claude-code"]; l != "Personal" {
		t.Fatalf("default label after reopen = %q", l)
	}
	if l := re.List()[0].Label; l != "Day job" {
		t.Fatalf("label after reopen = %q", l)
	}
}

// A file as main's first accounts release wrote it (no owned, no default
// labels) reads unchanged; a file with the new fields keeps the old ones.
func TestFileFormatIsReadBothWays(t *testing.T) {
	data := t.TempDir()
	dir := filepath.Join(t.TempDir(), "w")
	old := `{"accounts":[{"id":"work","agent":"claude-code","label":"Work","config_dir":"` + dir + `"}]}`
	if err := os.WriteFile(filepath.Join(data, accounts.File), []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}
	s := accounts.Open(data)
	if got := s.List(); len(got) != 1 || got[0].Owned || got[0].Label != "Work" {
		t.Fatalf("list = %+v", got)
	}
	if _, err := s.Rename(claude, "", "Personal"); err != nil {
		t.Fatal(err)
	}
	var body struct {
		Accounts      []map[string]any  `json:"accounts"`
		DefaultLabels map[string]string `json:"default_labels"`
	}
	raw, _ := os.ReadFile(filepath.Join(data, accounts.File))
	if err := json.Unmarshal(raw, &body); err != nil || len(body.Accounts) != 1 || body.Accounts[0]["config_dir"] != dir ||
		body.DefaultLabels["claude-code"] != "Personal" {
		t.Fatalf("file = %s", raw)
	}
	if _, has := body.Accounts[0]["owned"]; has {
		t.Fatalf("owned written for a folder Octo did not create: %s", raw)
	}
}
