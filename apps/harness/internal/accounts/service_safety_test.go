package accounts_test

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/accounts"
)

// A file that does not parse, or has another version, makes every change fail
// with ErrFileUnusable (not "one account only") and is never rewritten.
func TestUnusableFileRefusesEveryChangeAndStaysAsItIs(t *testing.T) {
	for name, body := range map[string]string{
		"corrupt":         `{"version":1,"accounts":[`,
		"empty":           ``,
		"newer version":   `{"version":2,"accounts":[]}`,
		"version missing": `{"accounts":[]}`,
	} {
		t.Run(name, func(t *testing.T) {
			data := t.TempDir()
			path := filepath.Join(data, accounts.FileName)
			if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
				t.Fatal(err)
			}
			s, reg, changes := open(t, data)
			_, addErr := s.Add("cc", "Work", "")
			_, renameErr := s.Rename("cc", "Main")
			_, renameAccErr := s.Rename("cc@work", "Main")
			_, removeErr := s.Remove("cc@work", true)
			for op, err := range map[string]error{"add": addErr, "rename default": renameErr, "rename account": renameAccErr, "remove": removeErr} {
				if !errors.Is(err, accounts.ErrFileUnusable) || errors.Is(err, accounts.ErrUnsupported) {
					t.Errorf("%s = %v, want ErrFileUnusable", op, err)
				}
			}
			if got, _ := os.ReadFile(path); string(got) != body {
				t.Fatalf("file rewritten: %q", got)
			}
			if reg.calls != 0 || changes.Load() != 0 {
				t.Fatalf("expanded %d times, changed %d times", reg.calls, changes.Load())
			}
			if _, err := os.Stat(filepath.Join(data, "accounts")); err == nil {
				t.Fatal("a folder was created")
			}
		})
	}
}

// writeRecords writes a store with the given accounts.
func writeRecords(t *testing.T, data string, accs ...accounts.Account) {
	t.Helper()
	b, err := json.Marshal(map[string]any{"version": 1, "accounts": accs, "default_names": map[string]string{}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, accounts.FileName), b, 0o600); err != nil {
		t.Fatal(err)
	}
}

func mustMkdir(t *testing.T, p string) {
	t.Helper()
	if err := os.MkdirAll(p, 0o700); err != nil {
		t.Fatal(err)
	}
}

// delete_data removes a folder only when the record is Owned, its folder is
// exactly {data}/accounts/<agent>/<id> and that stays inside the real root.
func TestDeleteDataOnlyRemovesTheFolderOctoCreated(t *testing.T) {
	for _, tc := range []struct {
		name       string
		setup      func(t *testing.T, data, outside string) accounts.Account
		wantDelete bool
	}{
		{"created by Octo", func(t *testing.T, data, _ string) accounts.Account {
			dir := filepath.Join(data, "accounts", "cc", "work")
			mustMkdir(t, dir)
			return accounts.Account{Agent: "cc", ID: "work", Name: "Work", Dir: dir, Owned: true}
		}, true},
		{"not owned", func(t *testing.T, data, _ string) accounts.Account {
			dir := filepath.Join(data, "accounts", "cc", "work")
			mustMkdir(t, dir)
			return accounts.Account{Agent: "cc", ID: "work", Name: "Work", Dir: dir}
		}, false},
		{"owned flag on a folder elsewhere", func(t *testing.T, data, outside string) accounts.Account {
			return accounts.Account{Agent: "cc", ID: "work", Name: "Work", Dir: outside, Owned: true}
		}, false},
		{"folder not named by agent and id", func(t *testing.T, data, _ string) accounts.Account {
			dir := filepath.Join(data, "accounts", "cc", "other")
			mustMkdir(t, dir)
			return accounts.Account{Agent: "cc", ID: "work", Name: "Work", Dir: dir, Owned: true}
		}, false},
		{"the accounts folder itself", func(t *testing.T, data, _ string) accounts.Account {
			return accounts.Account{Agent: "cc", ID: "work", Name: "Work", Dir: filepath.Join(data, "accounts"), Owned: true}
		}, false},
		{"dotdot in the agent", func(t *testing.T, data, _ string) accounts.Account {
			dir := filepath.Join(data, "work")
			mustMkdir(t, dir)
			return accounts.Account{Agent: "..", ID: "work", Name: "Work", Dir: dir, Owned: true}
		}, false},
		{"agent folder is a symlink out of the root", func(t *testing.T, data, outside string) accounts.Account {
			mustMkdir(t, filepath.Join(data, "accounts"))
			mustMkdir(t, filepath.Join(outside, "work"))
			if err := os.Symlink(outside, filepath.Join(data, "accounts", "cc")); err != nil {
				t.Skip("no symlinks:", err)
			}
			return accounts.Account{Agent: "cc", ID: "work", Name: "Work", Dir: filepath.Join(data, "accounts", "cc", "work"), Owned: true}
		}, false},
		{"account folder is itself a symlink", func(t *testing.T, data, outside string) accounts.Account {
			mustMkdir(t, filepath.Join(data, "accounts", "cc"))
			if err := os.Symlink(outside, filepath.Join(data, "accounts", "cc", "work")); err != nil {
				t.Skip("no symlinks:", err)
			}
			return accounts.Account{Agent: "cc", ID: "work", Name: "Work", Dir: filepath.Join(data, "accounts", "cc", "work"), Owned: true}
		}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data, outside := t.TempDir(), t.TempDir()
			keep := filepath.Join(outside, "keep.txt")
			if err := os.WriteFile(keep, []byte("x"), 0o600); err != nil {
				t.Fatal(err)
			}
			acc := tc.setup(t, data, outside)
			writeRecords(t, data, acc)
			s, _, _ := open(t, data)
			dir, err := s.Remove(acc.Agent+"@"+acc.ID, true)
			if err != nil {
				t.Fatal(err)
			}
			if len(s.List()) != 0 {
				t.Fatal("the record must go in every case")
			}
			if tc.wantDelete {
				if dir != acc.Dir {
					t.Fatalf("deletedDir = %q, want %q", dir, acc.Dir)
				}
				if _, err := os.Stat(acc.Dir); !os.IsNotExist(err) {
					t.Fatal("folder not deleted")
				}
				return
			}
			if dir != "" {
				t.Fatalf("deletedDir = %q, want empty", dir)
			}
			if _, err := os.Stat(keep); err != nil {
				t.Fatalf("a file outside the accounts folder was deleted: %v", err)
			}
			if _, err := os.Stat(data); err != nil {
				t.Fatal("the data folder was deleted")
			}
		})
	}
}

// A folder the user names is refused when it is the same place as another
// account's, whatever the spelling (trailing slash, symlink).
func TestAddRefusesAFolderAnotherAccountUsesWhateverItsSpelling(t *testing.T) {
	data, shared := t.TempDir(), t.TempDir()
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(shared, link); err != nil {
		t.Skip("no symlinks:", err)
	}
	s, _, _ := open(t, data)
	if _, err := s.Add("cc", "One", shared); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{shared + "/", shared + "/./", link, link + "/"} {
		if _, err := s.Add("cc", "Two", dir); !errors.Is(err, accounts.ErrInvalid) {
			t.Errorf("Add(%q) = %v, want ErrInvalid", dir, err)
		}
	}
	if len(s.List()) != 1 {
		t.Fatalf("accounts = %d", len(s.List()))
	}
}
