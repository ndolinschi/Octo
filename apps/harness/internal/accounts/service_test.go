package accounts_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/accounts"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
)

// fakeReg is a registry with a supported "cc", an unsupported "cop" and
// nothing else; it records the last SetAccounts.
type fakeReg struct {
	mu    sync.Mutex
	specs []plugins.AccountSpec
	names map[string]string
	calls int
}

func (r *fakeReg) SetAccounts(specs []plugins.AccountSpec, names map[string]string) []error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.specs, r.names = specs, names
	r.calls++
	return nil
}

func (r *fakeReg) Support(base string) (plugins.AccountsSupport, bool) {
	switch base {
	case "cc":
		return plugins.AccountsSupport{Supported: true}, true
	case "cop":
		return plugins.AccountsSupport{Reason: "shared keychain"}, true
	}
	return plugins.AccountsSupport{}, false
}

func open(t *testing.T, data string) (*accounts.Service, *fakeReg, *atomic.Int32) {
	t.Helper()
	reg := &fakeReg{}
	var changes atomic.Int32
	s, err := accounts.Open(data, reg, func() { changes.Add(1) })
	if err != nil {
		t.Fatal(err)
	}
	return s, reg, &changes
}

func TestAddRenameRemove(t *testing.T) {
	data := t.TempDir()
	s, reg, changes := open(t, data)
	work, err := s.Add("cc", "  Work  ", "")
	if err != nil {
		t.Fatal(err)
	}
	wantDir := filepath.Join(data, "accounts", "cc", "work")
	if work.ID != "work" || work.Name != "Work" || work.Dir != wantDir || !work.Owned || work.CreatedAt.IsZero() {
		t.Fatalf("added = %+v", work)
	}
	for _, d := range []string{filepath.Join(data, "accounts"), filepath.Join(data, "accounts", "cc"), wantDir} {
		if fi, err := os.Stat(d); err != nil || fi.Mode().Perm() != 0o700 {
			t.Fatalf("%s: %v %v, want mode 0700", d, fi.Mode(), err)
		}
	}
	if fi, err := os.Stat(filepath.Join(data, accounts.FileName)); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("store mode = %v %v", fi.Mode(), err)
	}
	if len(reg.specs) != 1 || reg.specs[0] != (plugins.AccountSpec{Agent: "cc", ID: "work", Name: "Work", Dir: wantDir, Owned: true}) || changes.Load() != 1 {
		t.Fatalf("registry = %+v, changes %d", reg.specs, changes.Load())
	}
	// A clash of names is refused; a clash of slugs is not ("work" taken: "work-2").
	if _, err := s.Add("cc", "work", ""); !errors.Is(err, accounts.ErrNameTaken) {
		t.Fatalf("same name: %v", err)
	}
	if _, err := s.Add("cc", "default", ""); !errors.Is(err, accounts.ErrNameTaken) {
		t.Fatalf("the default account's name: %v", err)
	}
	w2, err := s.Add("cc", "Work!", "")
	if err != nil || w2.ID != "work-2" {
		t.Fatalf("second = %+v %v", w2, err)
	}
	if a, err := s.Add("cc", "Default stuff", ""); err != nil || a.ID != "default-stuff" {
		t.Fatalf("slug = %+v %v", a, err)
	}
	// Renames: the id and folder stay; a base id renames the default account.
	r, err := s.Rename("cc@work-2", "Side")
	if err != nil || r.ID != "work-2" || r.Name != "Side" || r.Dir != w2.Dir {
		t.Fatalf("rename = %+v %v", r, err)
	}
	if _, err := s.Rename("cc@work-2", "WORK"); !errors.Is(err, accounts.ErrNameTaken) {
		t.Fatalf("rename onto a sibling: %v", err)
	}
	if d, err := s.Rename("cc", "Personal"); err != nil || d.ID != "" || d.Name != "Personal" || reg.names["cc"] != "Personal" {
		t.Fatalf("rename default = %+v %v %v", d, err, reg.names)
	}
	if _, err := s.Rename("cc@nope", "X"); !errors.Is(err, accounts.ErrUnknownAgent) {
		t.Fatalf("rename unknown: %v", err)
	}
	// Remove: the default cannot go; the folder goes only when owned and asked.
	if _, err := s.Remove("cc", true); !errors.Is(err, accounts.ErrDefault) {
		t.Fatalf("remove default: %v", err)
	}
	if dir, err := s.Remove("cc@work-2", false); err != nil || dir != "" {
		t.Fatalf("remove keep = %q %v", dir, err)
	}
	if _, err := os.Stat(w2.Dir); err != nil {
		t.Fatal("kept folder is gone")
	}
	if dir, err := s.Remove("cc@work", true); err != nil || dir != wantDir {
		t.Fatalf("remove delete = %q %v", dir, err)
	}
	if _, err := os.Stat(wantDir); !os.IsNotExist(err) {
		t.Fatal("deleted folder is still there")
	}
	if _, err := s.Remove("cc@work", true); !errors.Is(err, accounts.ErrUnknownAgent) {
		t.Fatalf("remove twice: %v", err)
	}
	// Reopening reads the same accounts back.
	s2, reg2, _ := open(t, data)
	if got := s2.List(); len(got) != 1 || got[0].ID != "default-stuff" || reg2.names["cc"] != "Personal" || len(reg2.specs) != 1 {
		t.Fatalf("reopened = %+v %v", got, reg2.names)
	}
}

func TestAddRefusals(t *testing.T) {
	data := t.TempDir()
	s, _, changes := open(t, data)
	file := filepath.Join(data, "f")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		agent, name, dir string
		want             error
	}{
		{"nope", "X", "", accounts.ErrUnknownAgent},
		{"cc@x", "X", "", accounts.ErrUnknownAgent},
		{"cop", "X", "", accounts.ErrUnsupported},
		{"cc", " ", "", accounts.ErrInvalid},
		{"cc", strings.Repeat("x", 41), "", accounts.ErrInvalid},
		{"cc", "X", "relative/dir", accounts.ErrInvalid},
		{"cc", "X", "/tmp/${HOME}", accounts.ErrInvalid},
		{"cc", "X", filepath.Join(data, "missing"), accounts.ErrInvalid},
		{"cc", "X", file, accounts.ErrInvalid},
	} {
		if _, err := s.Add(tc.agent, tc.name, tc.dir); !errors.Is(err, tc.want) {
			t.Errorf("Add(%q, %q, %q) = %v, want %v", tc.agent, tc.name, tc.dir, err, tc.want)
		}
	}
	if changes.Load() != 0 {
		t.Fatalf("a refused add changed something (%d)", changes.Load())
	}
	if !strings.Contains(fmt.Sprint(must(s.Add("cop", "X", ""))), "shared keychain") {
		t.Fatal("the reason must be carried")
	}
}

func must(_ accounts.Account, err error) error { return err }

func TestExistingFolderIsNotOwnedAndNeverDeleted(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.Mkdir(filepath.Join(home, ".claude-work"), 0o755); err != nil {
		t.Fatal(err)
	}
	s, _, _ := open(t, t.TempDir())
	a, err := s.Add("cc", "Work", "~/.claude-work")
	if err != nil || a.Owned || a.Dir != filepath.Join(home, ".claude-work") {
		t.Fatalf("add = %+v %v", a, err)
	}
	if _, err := s.Add("cc", "Again", a.Dir); !errors.Is(err, accounts.ErrInvalid) {
		t.Fatalf("a folder used twice: %v", err)
	}
	if dir, err := s.Remove("cc@work", true); err != nil || dir != "" {
		t.Fatalf("remove = %q %v", dir, err)
	}
	if _, err := os.Stat(a.Dir); err != nil {
		t.Fatal("a folder Octo did not create was deleted")
	}
}

func TestUnknownVersionIsLeftAlone(t *testing.T) {
	data := t.TempDir()
	path := filepath.Join(data, accounts.FileName)
	body := []byte(`{"version":2,"accounts":[{"agent":"cc","id":"x"}],"future":true}`)
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
	s, reg, _ := open(t, data)
	if reg.calls != 0 {
		t.Fatal("accounts of an unknown version must not be expanded")
	}
	if _, err := s.Add("cc", "Work", ""); !errors.Is(err, accounts.ErrFileUnusable) || errors.Is(err, accounts.ErrUnsupported) {
		t.Fatalf("add = %v", err)
	}
	if got, _ := os.ReadFile(path); string(got) != string(body) {
		t.Fatalf("file rewritten: %s", got)
	}
}

func TestConcurrentAdds(t *testing.T) {
	data := t.TempDir()
	s, _, changes := open(t, data)
	var wg sync.WaitGroup
	for i := range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := s.Add("cc", fmt.Sprintf("Team %d", i), ""); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	b, err := os.ReadFile(filepath.Join(data, accounts.FileName))
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Version  int
		Accounts []accounts.Account
	}
	if err := json.Unmarshal(b, &f); err != nil || f.Version != 1 || len(f.Accounts) != 12 || changes.Load() != 12 {
		t.Fatalf("file = %s (%v), changes %d", b, err, changes.Load())
	}
	seen := map[string]bool{}
	for _, a := range f.Accounts {
		if seen[a.ID] || !plugins.ValidSlug(a.ID) {
			t.Fatalf("slug %q repeated or invalid", a.ID)
		}
		seen[a.ID] = true
	}
}
