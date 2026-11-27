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

func writeRecords(t *testing.T, data string, accs ...plugins.Account) {
	t.Helper()
	b, err := json.Marshal(map[string]any{"accounts": accs})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, accounts.File), b, 0o600); err != nil {
		t.Fatal(err)
	}
}

func mustMkdir(t *testing.T, p string) {
	t.Helper()
	if err := os.MkdirAll(p, 0o700); err != nil {
		t.Fatal(err)
	}
}

// Removing with the folder deletes only a plain folder Octo created; any other
// record (hand-edited or not) is refused and kept, and nothing is deleted.
func TestRemoveWithFolderOnlyDeletesAFolderOctoCreated(t *testing.T) {
	home, _ := os.UserHomeDir()
	for _, tc := range []struct {
		name       string
		setup      func(t *testing.T, data, outside string) plugins.Account
		wantDelete bool
	}{
		{"created by Octo", func(t *testing.T, _, outside string) plugins.Account {
			mustMkdir(t, filepath.Join(outside, "work"))
			return plugins.Account{Agent: "claude-code", ID: "work", Label: "Work", ConfigDir: filepath.Join(outside, "work"), Owned: true}
		}, true},
		{"not owned", func(t *testing.T, _, outside string) plugins.Account {
			mustMkdir(t, filepath.Join(outside, "work"))
			return plugins.Account{Agent: "claude-code", ID: "work", Label: "Work", ConfigDir: filepath.Join(outside, "work")}
		}, false},
		{"owned flag on the home folder", func(t *testing.T, _, _ string) plugins.Account {
			return plugins.Account{Agent: "claude-code", ID: "work", Label: "Work", ConfigDir: home, Owned: true}
		}, false},
		{"owned flag on the data folder's parent", func(t *testing.T, data, _ string) plugins.Account {
			return plugins.Account{Agent: "claude-code", ID: "work", Label: "Work", ConfigDir: filepath.Dir(data), Owned: true}
		}, false},
		{"owned flag on the root", func(t *testing.T, _, _ string) plugins.Account {
			return plugins.Account{Agent: "claude-code", ID: "work", Label: "Work", ConfigDir: "/", Owned: true}
		}, false},
		{"account folder is a symlink", func(t *testing.T, _, outside string) plugins.Account {
			mustMkdir(t, filepath.Join(outside, "target"))
			link := filepath.Join(outside, "work")
			if err := os.Symlink(filepath.Join(outside, "target"), link); err != nil {
				t.Skip("no symlinks:", err)
			}
			return plugins.Account{Agent: "claude-code", ID: "work", Label: "Work", ConfigDir: link, Owned: true}
		}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data, outside := t.TempDir(), t.TempDir()
			acct := tc.setup(t, data, outside)
			writeRecords(t, data, acct)
			s := accounts.Open(data)
			if len(s.List()) != 1 {
				t.Skipf("record not loaded: %+v", acct)
			}
			deleted, err := s.RemoveWithFolder("claude-code", "work", true, "~/.claude")
			if tc.wantDelete {
				if err != nil || deleted == "" {
					t.Fatalf("remove = %q %v", deleted, err)
				}
				if _, err := os.Stat(acct.ConfigDir); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("folder still there: %v", err)
				}
				return
			}
			if !errors.Is(err, accounts.ErrNotOwned) || deleted != "" {
				t.Fatalf("remove = %q %v, want ErrNotOwned", deleted, err)
			}
			if len(s.List()) != 1 {
				t.Fatal("a refused removal removed the account")
			}
			if _, err := os.Lstat(acct.ConfigDir); err != nil {
				t.Fatalf("the folder was touched: %v", err)
			}
		})
	}
}

// Without delete, an owned folder stays (the owner's rule for Remove).
func TestRemoveKeepsTheFolderUnlessAsked(t *testing.T) {
	s := accounts.Open(t.TempDir())
	dir := filepath.Join(t.TempDir(), "w")
	if _, err := s.Add(claude, plugins.Account{Label: "W", ConfigDir: dir}); err != nil {
		t.Fatal(err)
	}
	if deleted, err := s.RemoveWithFolder("claude-code", "w", false, ""); err != nil || deleted != "" {
		t.Fatalf("remove = %q %v", deleted, err)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatal(err)
	}
}

// The guards that do not depend on the record alone: a folder holding the
// agent's default folder (Devin's ~/.local/share in ~/.local), and an unknown
// home folder (fail closed).
func TestRemoveWithFolderRefusesAnAncestorOfTheDefaultAndAnUnknownHome(t *testing.T) {
	for _, tc := range []struct {
		name    string
		noHome  bool
		def     func(acct string) string
		allowed bool
	}{
		{"ancestor of the default folder", false, func(acct string) string { return filepath.Join(acct, "share") }, false},
		{"the default folder itself", false, func(acct string) string { return acct }, false},
		{"a sibling of the default folder", false, func(acct string) string { return acct + "-other" }, true},
		{"home folder unknown", true, func(string) string { return "" }, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data, outside := t.TempDir(), t.TempDir()
			dir := filepath.Join(outside, "local")
			mustMkdir(t, filepath.Join(dir, "share"))
			acct := plugins.Account{Agent: "devin", ID: "work", Label: "Work", ConfigDir: dir, Owned: true}
			writeRecords(t, data, acct)
			s := accounts.Open(data)
			if len(s.List()) != 1 {
				t.Fatalf("record not loaded: %+v", acct)
			}
			if tc.noHome {
				t.Setenv("HOME", "")
			}
			deleted, err := s.RemoveWithFolder("devin", "work", true, tc.def(dir))
			if tc.allowed {
				if err != nil || deleted == "" {
					t.Fatalf("remove = %q %v", deleted, err)
				}
				return
			}
			if !errors.Is(err, accounts.ErrNotOwned) || deleted != "" {
				t.Fatalf("remove = %q %v, want ErrNotOwned", deleted, err)
			}
			if _, err := os.Stat(filepath.Join(dir, "share")); err != nil {
				t.Fatalf("the folder was touched: %v", err)
			}
		})
	}
}

// Owned is the store's finding, never the caller's: an existing folder is not
// Octo's even when the input says it is.
func TestAddDecidesOwnedItself(t *testing.T) {
	for _, tc := range []struct {
		name   string
		exists bool
		want   bool
	}{
		{"existing folder, caller says owned", true, false},
		{"new folder", false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := accounts.Open(t.TempDir())
			dir := filepath.Join(t.TempDir(), "w")
			if tc.exists {
				mustMkdir(t, dir)
			}
			got, err := s.Add(claude, plugins.Account{Label: "W", ConfigDir: dir, Owned: true})
			if err != nil {
				t.Fatal(err)
			}
			if got.Owned != tc.want || s.List()[0].Owned != tc.want {
				t.Fatalf("owned = %v (stored %v), want %v", got.Owned, s.List()[0].Owned, tc.want)
			}
		})
	}
}
