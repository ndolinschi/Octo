// Package accounts keeps the user's extra agent accounts: more logins of an
// agent whose manifest has `accounts` (Claude Code, Codex), each a label and
// the folder its CLI keeps that login in (CLAUDE_CONFIG_DIR, CODEX_HOME). The
// plugin registry serves each one as an agent of its own, "<agent>@<account>",
// so it can be chosen per project, per session and per delegation like any
// other agent.
//
// Only the label and the folder are stored, in {data-dir}/agent-accounts.json,
// with whether Octo created the folder ("owned") and the names the user gave
// the agents' own logins ("default_labels"). Nothing here reads the folder, a
// token or a credential: the user logs the folder in with the CLI's own login
// command.
package accounts

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
)

// File is the store's file name in the data directory.
const File = "agent-accounts.json"

// Limits of what the store accepts.
const (
	MaxPerAgent = 20
	MaxLabelLen = 40
	MaxDirLen   = 512
)

// Errors of Add and Remove. An *InvalidError says which field is wrong.
var (
	ErrUnknownAgent = errors.New("no such agent")
	ErrNotSupported = errors.New("the agent has no accounts")
	ErrTaken        = errors.New("an account with that id or folder exists")
	ErrFull         = errors.New("too many accounts for the agent")
	ErrNotFound     = errors.New("no such account")
	// ErrNotOwned: removing with the folder was asked for a folder Octo may not delete.
	ErrNotOwned = errors.New("octo did not create the account's folder")
)

// InvalidError is a field the store refuses: "label", "id" or "config_dir".
type InvalidError struct {
	Field  string
	Reason string
}

func (e *InvalidError) Error() string { return e.Field + ": " + e.Reason }

var idPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,31}$`)

// Store is the accounts file, read once and rewritten on every change.
type Store struct {
	path string
	mu   sync.Mutex
	list []plugins.Account
	// labels names the agents' own (default) logins, by agent id.
	labels map[string]string
}

// fileBody is the file. DefaultLabels is optional: a file without it (as
// written before default names existed) reads as no names.
type fileBody struct {
	Accounts      []plugins.Account `json:"accounts"`
	DefaultLabels map[string]string `json:"default_labels,omitempty"`
}

// Open reads {dataDir}/agent-accounts.json. A missing file is an empty store;
// an unreadable one is logged and treated as empty (it is replaced on the next
// change). An empty dataDir keeps the store in memory only.
func Open(dataDir string) *Store {
	s := &Store{}
	if dataDir == "" {
		return s
	}
	s.path = filepath.Join(dataDir, File)
	data, err := os.ReadFile(s.path)
	switch {
	case errors.Is(err, os.ErrNotExist):
		return s
	case err != nil:
		slog.Warn("agent accounts unreadable; starting without them", "path", s.path, "err", err)
		return s
	}
	var body fileBody
	if err := json.Unmarshal(data, &body); err != nil {
		slog.Warn("agent accounts file is not valid JSON; starting without them", "path", s.path, "err", err)
		return s
	}
	for _, a := range body.Accounts {
		if validate(a) == nil {
			s.list = append(s.list, a)
		}
	}
	for agent, l := range body.DefaultLabels {
		if validLabel(l) == nil {
			if s.labels == nil {
				s.labels = map[string]string{}
			}
			s.labels[agent] = l
		}
	}
	return s
}

// List returns the accounts in the order they were added.
func (s *Store) List() []plugins.Account {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.list)
}

// Add stores a new account of agent base (which must have `accounts` in its
// manifest: base.AccountEnv). An empty in.ID is made from the label. The
// folder is created (0700) when it does not exist yet, so the CLI's login
// can write into it.
func (s *Store) Add(base plugins.Agent, in plugins.Account) (plugins.Account, error) {
	if base.AccountOf != "" || base.AccountEnv == "" {
		return plugins.Account{}, ErrNotSupported
	}
	in.Agent = base.ID
	in.Label = strings.TrimSpace(in.Label)
	in.ConfigDir = strings.TrimSpace(in.ConfigDir)
	in.ID = strings.TrimSpace(in.ID)
	if in.ID == "" {
		in.ID = Slug(in.Label)
	}
	if err := validate(in); err != nil {
		return plugins.Account{}, err
	}
	dir := filepath.Clean(plugins.ExpandAccountDir(in.ConfigDir))
	real := realPath(dir)
	if base.AccountDefault != "" && real == realPath(plugins.ExpandAccountDir(base.AccountDefault)) {
		return plugins.Account{}, &InvalidError{Field: "config_dir", Reason: "is the agent's default folder, which its own entry already uses"}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, a := range s.list {
		if a.Agent != in.Agent {
			continue
		}
		n++
		if a.ID == in.ID {
			return plugins.Account{}, ErrTaken
		}
	}
	// A folder is one login, whichever agent and whatever spelling (a
	// trailing slash, a symlink) names it.
	if slices.ContainsFunc(s.list, func(a plugins.Account) bool { return realPath(plugins.ExpandAccountDir(a.ConfigDir)) == real }) {
		return plugins.Account{}, ErrTaken
	}
	if n >= MaxPerAgent {
		return plugins.Account{}, ErrFull
	}
	// Owned: the folder does not exist yet, so Octo creates it (and may delete
	// it when the account is removed, if the user asks).
	if _, err := os.Lstat(dir); errors.Is(err, os.ErrNotExist) {
		in.Owned = true
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return plugins.Account{}, &InvalidError{Field: "config_dir", Reason: "cannot be created: " + err.Error()}
	}
	next := append(slices.Clone(s.list), in)
	if err := s.write(next, s.labels); err != nil {
		if in.Owned {
			_ = os.Remove(dir) // only while it is still empty
		}
		return plugins.Account{}, err
	}
	s.list = next
	slog.Info("agent account added", "agent", in.Agent, "account", in.ID)
	return in, nil
}

// Remove forgets an account. Its folder (and the login in it) stays on disk.
func (s *Store) Remove(agent, id string) error {
	_, err := s.RemoveWithFolder(agent, id, false, "")
	return err
}

func (s *Store) write(list []plugins.Account, labels map[string]string) error {
	if s.path == "" {
		return nil
	}
	if list == nil {
		list = []plugins.Account{}
	}
	data, err := json.MarshalIndent(fileBody{Accounts: list, DefaultLabels: labels}, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".agent-accounts-*")
	if err != nil {
		return fmt.Errorf("write agent accounts: %w", err)
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		tmp.Close()
		return fmt.Errorf("write agent accounts: %w", err)
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return fmt.Errorf("write agent accounts: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("write agent accounts: %w", err)
	}
	if err := os.Rename(tmp.Name(), s.path); err != nil {
		return fmt.Errorf("write agent accounts: %w", err)
	}
	return nil
}

// validate checks one account's fields (not its agent or its uniqueness).
func validate(a plugins.Account) error {
	if err := validLabel(a.Label); err != nil {
		return err
	}
	if !idPattern.MatchString(a.ID) {
		return &InvalidError{Field: "id", Reason: "must be lower-case letters, digits and hyphens, at most 32"}
	}
	return validDir(a.ConfigDir)
}

func validLabel(l string) error {
	if l == "" || utf8.RuneCountInString(l) > MaxLabelLen || strings.IndexFunc(l, unicode.IsControl) >= 0 {
		return &InvalidError{Field: "label", Reason: fmt.Sprintf("must be 1 to %d characters without control characters", MaxLabelLen)}
	}
	return nil
}

func validDir(dir string) error {
	bad := func(why string) error { return &InvalidError{Field: "config_dir", Reason: why} }
	switch {
	case dir == "":
		return bad("is required")
	case len(dir) > MaxDirLen:
		return bad(fmt.Sprintf("is longer than %d bytes", MaxDirLen))
	case strings.ContainsAny(dir, "$\x00") || strings.IndexFunc(dir, unicode.IsControl) >= 0:
		return bad("must not contain $ or control characters")
	case strings.HasPrefix(dir, "~/"):
		if plugins.ExpandAccountDir(dir) == "" {
			return bad("starts with ~/ but the home folder is unknown")
		}
		return nil
	case filepath.IsAbs(dir):
		return nil
	default:
		return bad("must be a full path or start with ~/")
	}
}
