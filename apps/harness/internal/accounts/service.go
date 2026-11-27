package accounts

import (
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
)

// MaxNameLen is the longest account name, in characters.
const MaxNameLen = 40

// Errors of the service; each is wrapped with the detail.
var (
	ErrUnknownAgent = errors.New("no such agent or account")
	ErrUnsupported  = errors.New("the agent cannot keep more than one account")
	ErrNameTaken    = errors.New("an account of the agent has that name")
	ErrDefault      = errors.New("the default account cannot be removed")
	ErrInvalid      = errors.New("invalid account")
)

// Registry is what the service needs of the plugin registry.
type Registry interface {
	SetAccounts(specs []plugins.AccountSpec, defaultNames map[string]string) []error
	Support(base string) (plugins.AccountsSupport, bool)
}

// Service adds, renames and removes accounts; after every change it expands
// them into the registry (SetAccounts) and calls onChange. Safe for concurrent use.
type Service struct {
	path     string // {data}/agent-accounts.json
	root     string // {data}/accounts: the folders Octo creates
	reg      Registry
	onChange func()
	now      func() time.Time

	mu  sync.Mutex
	f   file
	off error // set (wraps ErrFileUnusable) when the file cannot be used: nothing is read or written
}

// Open reads the store in dataDir and expands its accounts into reg. A file
// that does not parse or has an unknown version is left untouched and accounts
// stay off (logged): every change is then refused with ErrFileUnusable. Only a
// file that cannot be read at all is an error.
func Open(dataDir string, reg Registry, onChange func()) (*Service, error) {
	s := &Service{path: filepath.Join(dataDir, FileName), root: filepath.Join(dataDir, "accounts"), reg: reg, onChange: onChange, now: time.Now}
	f, err := readFile(s.path)
	switch {
	case errors.Is(err, ErrFileUnusable):
		slog.Warn("agent accounts off: the accounts file is not one this harness reads; it is left as is", "file", s.path, "err", err)
		s.off = err
		return s, nil
	case err != nil:
		return nil, err
	}
	s.f = f
	s.apply()
	return s, nil
}

// List returns the stored accounts (default accounts have no record).
func (s *Service) List() []Account {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.f.Accounts)
}

// apply expands the stored accounts into the registry. Caller holds s.mu (or owns s).
func (s *Service) apply() {
	specs := make([]plugins.AccountSpec, len(s.f.Accounts))
	for i, a := range s.f.Accounts {
		specs[i] = plugins.AccountSpec{Agent: a.Agent, ID: a.ID, Name: a.Name, Dir: a.Dir, Owned: a.Owned}
	}
	for _, err := range s.reg.SetAccounts(specs, maps.Clone(s.f.DefaultNames)) {
		slog.Warn("agent account kept but not offered", "err", err)
	}
}

// commit writes next, makes it current and expands it. Caller holds s.mu.
func (s *Service) commit(next file) error {
	if err := writeFile(s.path, next); err != nil {
		return err
	}
	s.f = next
	s.apply()
	return nil
}

func (s *Service) changed() {
	if s.onChange != nil {
		s.onChange()
	}
}

// Add creates an account of base agent agent named name. dir "" makes Octo
// create (and own) {data}/accounts/<agent>/<slug>; otherwise dir is an
// existing folder ("~/" expanded) that Octo never deletes.
func (s *Service) Add(agent, name, dir string) (Account, error) {
	name, err := checkName(name)
	if err != nil {
		return Account{}, err
	}
	if err := s.supported(agent); err != nil {
		return Account{}, err
	}
	owned := strings.TrimSpace(dir) == ""
	if !owned {
		if dir, err = userDir(dir); err != nil {
			return Account{}, err
		}
	}
	s.mu.Lock()
	acc, err := s.addLocked(agent, name, dir, owned)
	s.mu.Unlock()
	if err != nil {
		return Account{}, err
	}
	slog.Info("agent account added", "agent", agent, "account", acc.ID, "owned", acc.Owned)
	s.changed()
	return acc, nil
}

func (s *Service) addLocked(agent, name, dir string, owned bool) (Account, error) {
	if s.off != nil {
		return Account{}, s.off
	}
	if s.nameTaken(agent, name, nil) {
		return Account{}, fmt.Errorf("%w: %q", ErrNameTaken, name)
	}
	slug, err := s.newSlug(agent, name)
	if err != nil {
		return Account{}, err
	}
	if owned {
		dir = filepath.Join(s.root, agent, slug)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return Account{}, fmt.Errorf("create the account folder: %w", err)
		}
		for _, d := range []string{s.root, filepath.Dir(dir), dir} {
			if err := os.Chmod(d, 0o700); err != nil {
				return Account{}, fmt.Errorf("protect the account folder: %w", err)
			}
		}
	} else if s.dirUsed(dir) {
		return Account{}, fmt.Errorf("%w: another account uses that folder", ErrInvalid)
	}
	acc := Account{Agent: agent, ID: slug, Name: name, Dir: dir, Owned: owned, CreatedAt: s.now().UTC().Truncate(time.Second)}
	next := s.clone()
	next.Accounts = append(next.Accounts, acc)
	if err := s.commit(next); err != nil {
		if owned {
			_ = os.Remove(dir) // only while still empty
		}
		return Account{}, err
	}
	return acc, nil
}

// Rename changes the display name of an account; a base agent id renames its
// default account. The id and the folder never change.
func (s *Service) Rename(id, name string) (Account, error) {
	name, err := checkName(name)
	if err != nil {
		return Account{}, err
	}
	base, slug := plugins.SplitID(id)
	if slug == "" {
		if err := s.supported(base); err != nil {
			return Account{}, err
		}
	}
	s.mu.Lock()
	acc, err := s.renameLocked(base, slug, id, name)
	s.mu.Unlock()
	if err != nil {
		return Account{}, err
	}
	s.changed()
	return acc, nil
}

func (s *Service) renameLocked(base, slug, id, name string) (Account, error) {
	if s.off != nil {
		return Account{}, s.off
	}
	next := s.clone()
	var acc Account
	if slug == "" {
		if s.nameTaken(base, name, &Account{Agent: base}) {
			return Account{}, fmt.Errorf("%w: %q", ErrNameTaken, name)
		}
		next.DefaultNames[base] = name
		acc = Account{Agent: base, Name: name}
	} else {
		i := s.index(base, slug)
		if i < 0 {
			return Account{}, fmt.Errorf("%w: %s", ErrUnknownAgent, id)
		}
		if s.nameTaken(base, name, &s.f.Accounts[i]) {
			return Account{}, fmt.Errorf("%w: %q", ErrNameTaken, name)
		}
		next.Accounts[i].Name = name
		acc = next.Accounts[i]
	}
	if err := s.commit(next); err != nil {
		return Account{}, err
	}
	return acc, nil
}

// Remove deletes an account. Its folder is deleted only when deleteData is set
// and the folder is exactly the one Octo creates for the account under
// {data}/accounts (deletable); deletedDir is that folder ("" when it was kept).
func (s *Service) Remove(id string, deleteData bool) (deletedDir string, err error) {
	base, slug := plugins.SplitID(id)
	if slug == "" {
		if _, ok := s.reg.Support(base); ok {
			return "", fmt.Errorf("%w: %s", ErrDefault, id)
		}
		return "", fmt.Errorf("%w: %s", ErrUnknownAgent, id)
	}
	s.mu.Lock()
	acc, err := s.removeLocked(base, slug, id)
	s.mu.Unlock()
	if err != nil {
		return "", err
	}
	del := deleteData && s.deletable(acc)
	slog.Info("agent account removed", "agent", base, "account", slug, "delete_data", del)
	if deleteData && !del {
		slog.Warn("agent account folder kept: it is not one Octo created under its accounts folder", "agent", base, "account", slug)
	}
	if del {
		if err := os.RemoveAll(acc.Dir); err != nil {
			slog.Warn("agent account folder not deleted", "agent", base, "account", slug, "err", err)
		} else {
			deletedDir = acc.Dir
		}
	}
	s.changed()
	return deletedDir, nil
}

func (s *Service) removeLocked(base, slug, id string) (Account, error) {
	if s.off != nil {
		return Account{}, s.off
	}
	i := s.index(base, slug)
	if i < 0 {
		return Account{}, fmt.Errorf("%w: %s", ErrUnknownAgent, id)
	}
	acc := s.f.Accounts[i]
	next := s.clone()
	next.Accounts = slices.Delete(next.Accounts, i, i+1)
	return acc, s.commit(next)
}

func (s *Service) supported(base string) error {
	sup, ok := s.reg.Support(base)
	switch {
	case !ok:
		return fmt.Errorf("%w: %s", ErrUnknownAgent, base)
	case !sup.Supported:
		return fmt.Errorf("%w: %s", ErrUnsupported, sup.Reason)
	}
	return nil
}

func (s *Service) clone() file {
	return file{Version: fileVersion, Accounts: slices.Clone(s.f.Accounts), DefaultNames: maps.Clone(s.f.DefaultNames)}
}

func (s *Service) index(base, slug string) int {
	return slices.IndexFunc(s.f.Accounts, func(a Account) bool { return a.Agent == base && a.ID == slug })
}
