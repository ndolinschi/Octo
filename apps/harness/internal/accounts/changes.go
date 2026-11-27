package accounts

import (
	"log/slog"
	"maps"
	"os"
	"slices"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
)

// DefaultLabels returns the names the user gave the agents' own (default)
// logins, by agent id.
func (s *Store) DefaultLabels() map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return maps.Clone(s.labels)
}

// Rename gives account id of base a new label; id "" names base's own
// (default) login. The account's id and folder never change. A label another
// login of the same agent has already (ignoring case) is ErrTaken.
func (s *Store) Rename(base plugins.Agent, id, label string) (plugins.Account, error) {
	if base.AccountOf != "" || base.AccountEnv == "" {
		return plugins.Account{}, ErrNotSupported
	}
	label = strings.TrimSpace(label)
	if err := validLabel(label); err != nil {
		return plugins.Account{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	i := -1
	if id != "" {
		if i = s.index(base.ID, id); i < 0 {
			return plugins.Account{}, ErrNotFound
		}
	}
	if s.labelTaken(base.ID, id, label) {
		return plugins.Account{}, ErrTaken
	}
	list, labels := s.list, s.labels
	if i >= 0 {
		list = slices.Clone(s.list)
		list[i].Label = label
	} else {
		labels = maps.Clone(s.labels)
		if labels == nil {
			labels = map[string]string{}
		}
		labels[base.ID] = label
	}
	if err := s.write(list, labels); err != nil {
		return plugins.Account{}, err
	}
	s.list, s.labels = list, labels
	slog.Info("agent account renamed", "agent", base.ID, "account", id)
	if i >= 0 {
		return list[i], nil
	}
	return plugins.Account{Agent: base.ID, Label: label}, nil
}

// labelTaken: another login of agent than id has label. Caller holds s.mu.
func (s *Store) labelTaken(agent, id, label string) bool {
	if id != "" && strings.EqualFold(s.labels[agent], label) {
		return true
	}
	return slices.ContainsFunc(s.list, func(a plugins.Account) bool {
		return a.Agent == agent && a.ID != id && strings.EqualFold(a.Label, label)
	})
}

func (s *Store) index(agent, id string) int {
	return slices.IndexFunc(s.list, func(a plugins.Account) bool { return a.Agent == agent && a.ID == id })
}

// RemoveWithFolder forgets account id of agent. With deleteFolder the folder
// is deleted too, but only one Octo may delete (deletable): otherwise the
// account is kept and the answer is ErrNotOwned. deleted is the folder
// deleted ("" when it was kept). defaultDir is the agent's default folder
// (manifest accounts.default), which is never deleted.
func (s *Store) RemoveWithFolder(agent, id string, deleteFolder bool, defaultDir string) (deleted string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := s.index(agent, id)
	if i < 0 {
		return "", ErrNotFound
	}
	acct := s.list[i]
	if deleteFolder && !s.deletable(defaultDir, acct) {
		return "", ErrNotOwned
	}
	next := slices.Delete(slices.Clone(s.list), i, i+1)
	if err := s.write(next, s.labels); err != nil {
		return "", err
	}
	s.list = next
	slog.Info("agent account removed", "agent", agent, "account", id, "delete_folder", deleteFolder)
	if !deleteFolder {
		return "", nil
	}
	dir := plugins.ExpandAccountDir(acct.ConfigDir)
	if err := os.RemoveAll(dir); err != nil {
		slog.Warn("agent account folder not deleted", "agent", agent, "account", id, "err", err)
		return "", nil
	}
	return dir, nil
}
