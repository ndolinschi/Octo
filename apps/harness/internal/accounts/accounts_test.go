package accounts_test

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/accounts"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
)

var claude = plugins.Agent{ID: "claude-code", Label: "Claude Code", AccountEnv: "CLAUDE_CONFIG_DIR", AccountDefault: "~/.claude"}

func TestAddListRemovePersist(t *testing.T) {
	data := t.TempDir()
	s := accounts.Open(data)
	dir := filepath.Join(t.TempDir(), "work")
	a, err := s.Add(claude, plugins.Account{Label: "  Work Account ", ConfigDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if a.ID != "work-account" || a.Agent != "claude-code" || a.Label != "Work Account" || a.ConfigDir != dir {
		t.Fatalf("added = %+v", a)
	}
	if fi, err := os.Stat(dir); err != nil || fi.Mode().Perm() != 0o700 {
		t.Fatalf("folder: %v %v", fi, err)
	}
	// A second store over the same data dir reads it back.
	if got := accounts.Open(data).List(); len(got) != 1 || got[0] != a {
		t.Fatalf("reopened = %+v", got)
	}
	if err := s.Remove("claude-code", "nope"); !errors.Is(err, accounts.ErrNotFound) {
		t.Fatalf("remove unknown = %v", err)
	}
	if err := s.Remove("claude-code", a.ID); err != nil {
		t.Fatal(err)
	}
	if got := accounts.Open(data).List(); len(got) != 0 {
		t.Fatalf("after remove = %+v", got)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("remove deleted the folder: %v", err)
	}
}

func TestAddRefusals(t *testing.T) {
	s := accounts.Open("")
	tmp := t.TempDir()
	if _, err := s.Add(claude, plugins.Account{Label: "A", ConfigDir: filepath.Join(tmp, "a")}); err != nil {
		t.Fatal(err)
	}
	invalid := func(field string) func(error) bool {
		return func(err error) bool {
			var ie *accounts.InvalidError
			return errors.As(err, &ie) && ie.Field == field
		}
	}
	is := func(target error) func(error) bool { return func(err error) bool { return errors.Is(err, target) } }
	cases := []struct {
		name  string
		agent plugins.Agent
		in    plugins.Account
		want  func(error) bool
	}{
		{"same id", claude, plugins.Account{Label: "A", ConfigDir: filepath.Join(tmp, "b")}, is(accounts.ErrTaken)},
		{"same folder", claude, plugins.Account{Label: "B", ConfigDir: filepath.Join(tmp, "a") + "/"}, is(accounts.ErrTaken)},
		{"no label", claude, plugins.Account{Label: " ", ConfigDir: filepath.Join(tmp, "c")}, invalid("label")},
		{"long label", claude, plugins.Account{Label: strings.Repeat("x", 41), ConfigDir: filepath.Join(tmp, "c")}, invalid("label")},
		{"control", claude, plugins.Account{Label: "a\nb", ConfigDir: filepath.Join(tmp, "c")}, invalid("label")},
		{"bad id", claude, plugins.Account{ID: "Not_OK", Label: "C", ConfigDir: filepath.Join(tmp, "c")}, invalid("id")},
		{"relative", claude, plugins.Account{Label: "C", ConfigDir: "rel/dir"}, invalid("config_dir")},
		{"dollar", claude, plugins.Account{Label: "C", ConfigDir: "/tmp/$HOME"}, invalid("config_dir")},
		{"no folder", claude, plugins.Account{Label: "C"}, invalid("config_dir")},
		{"default folder", claude, plugins.Account{Label: "C", ConfigDir: "~/.claude"}, invalid("config_dir")},
		{"no accounts", plugins.Agent{ID: "grok"}, plugins.Account{Label: "C", ConfigDir: filepath.Join(tmp, "c")}, is(accounts.ErrNotSupported)},
		{"of an account", plugins.Agent{ID: "claude-code@a", AccountOf: "claude-code", AccountEnv: "X"}, plugins.Account{Label: "C", ConfigDir: filepath.Join(tmp, "c")}, is(accounts.ErrNotSupported)},
	}
	for _, c := range cases {
		if _, err := s.Add(c.agent, c.in); !c.want(err) {
			t.Errorf("%s: err = %v", c.name, err)
		}
	}
	if n := len(s.List()); n != 1 {
		t.Fatalf("refusals stored something: %d", n)
	}
}

func TestAccountsFull(t *testing.T) {
	s := accounts.Open("")
	tmp := t.TempDir()
	for i := range accounts.MaxPerAgent {
		if _, err := s.Add(claude, plugins.Account{Label: "A" + string(rune('a'+i)), ConfigDir: filepath.Join(tmp, string(rune('a'+i)))}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.Add(claude, plugins.Account{Label: "Last", ConfigDir: filepath.Join(tmp, "last")}); !errors.Is(err, accounts.ErrFull) {
		t.Fatalf("err = %v", err)
	}
}

func TestOpenSkipsBadFile(t *testing.T) {
	data := t.TempDir()
	body := `{"accounts":[{"id":"ok","agent":"codex","label":"Ok","config_dir":"/tmp/ok"},{"id":"Bad!","agent":"codex","label":"B","config_dir":"/tmp/b"},{"id":"rel","agent":"codex","label":"R","config_dir":"rel"}]}`
	if err := os.WriteFile(filepath.Join(data, accounts.File), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := accounts.Open(data).List(); len(got) != 1 || got[0].ID != "ok" {
		t.Fatalf("list = %+v", got)
	}
	if err := os.WriteFile(filepath.Join(data, accounts.File), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := accounts.Open(data).List(); len(got) != 0 {
		t.Fatalf("list = %+v", got)
	}
}

func TestSlug(t *testing.T) {
	for in, want := range map[string]string{
		"Work":                   "work",
		"  My Personal (2) ":     "my-personal-2",
		"Работа":                 "account",
		"a__b--c":                "a-b-c",
		strings.Repeat("ab", 40): strings.Repeat("ab", 16),
	} {
		if got := accounts.Slug(in); got != want {
			t.Errorf("Slug(%q) = %q, want %q", in, got, want)
		}
	}
}
