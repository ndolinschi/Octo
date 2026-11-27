package accounts

import (
	"context"

	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/providers"
)

// Service is the store wired to the running harness: it finds the agent an
// account is added to, and after a change refreshes the providers list and
// checks the new account's login (its own probe, run with its folder).
type Service struct {
	Store *Store
	// Agent looks up a loaded agent by id (plugins.Registry.Agent).
	Agent func(id string) (plugins.Agent, bool)
	// Recheck runs an agent's login probe now and answers its providers entry
	// (providers.Service.Recheck).
	Recheck func(ctx context.Context, id string) (providers.Provider, error)
	// Refresh republishes the providers list (providers.Service.Refresh).
	Refresh func()
	// Provider answers an entry of the providers list without probing it
	// (providers.Service.Provider); optional, Recheck is used without it.
	Provider func(id string) (providers.Provider, bool)
	// Forget drops the registry's state of a removed account's agent id
	// (plugins.Registry.Forget); optional.
	Forget func(id string)
}

// Add stores an account of agent and answers the providers entry of the
// account's own agent with its login checked.
func (s *Service) Add(ctx context.Context, agent string, in plugins.Account) (providers.Provider, error) {
	base, ok := s.Agent(agent)
	if !ok {
		return providers.Provider{}, ErrUnknownAgent
	}
	acct, err := s.Store.Add(base, in)
	if err != nil {
		return providers.Provider{}, err
	}
	if s.Refresh != nil {
		s.Refresh()
	}
	return s.Recheck(ctx, plugins.AccountAgentID(acct.Agent, acct.ID))
}

// Remove forgets an account of agent.
func (s *Service) Remove(agent, id string) error {
	_, err := s.RemoveWithFolder(agent, id, false)
	return err
}

// Label is the display name of agent, or its id when it is not loaded.
func (s *Service) Label(agent string) string {
	if a, ok := s.Agent(agent); ok && a.Label != "" {
		return a.Label
	}
	return agent
}

// Rename gives an account a new label and answers its providers entry. id is
// the account's own agent id ("claude-code@work"), or an agent's id to name
// that agent's own (default) login.
func (s *Service) Rename(ctx context.Context, id, label string) (providers.Provider, error) {
	agent, acct, _ := plugins.SplitAccountID(id)
	if acct == "" {
		agent = id
	}
	base, ok := s.Agent(agent)
	if !ok {
		return providers.Provider{}, ErrUnknownAgent
	}
	if _, err := s.Store.Rename(base, acct, label); err != nil {
		return providers.Provider{}, err
	}
	if s.Refresh != nil {
		s.Refresh()
	}
	if s.Provider != nil {
		if p, ok := s.Provider(id); ok {
			return p, nil
		}
	}
	return s.Recheck(ctx, id)
}

// RemoveWithFolder is Remove that also deletes the account's folder when
// deleteFolder is set and Octo created it (ErrNotOwned otherwise, and nothing
// is removed). deleted is the folder deleted ("" when kept).
func (s *Service) RemoveWithFolder(agent, id string, deleteFolder bool) (deleted string, err error) {
	base, ok := s.Agent(agent)
	if !ok {
		return "", ErrUnknownAgent
	}
	if deleted, err = s.Store.RemoveWithFolder(agent, id, deleteFolder, base.AccountDefault); err != nil {
		return "", err
	}
	if s.Forget != nil {
		s.Forget(plugins.AccountAgentID(agent, id))
	}
	if s.Refresh != nil {
		s.Refresh()
	}
	return deleted, nil
}

// Unsupported is why agent keeps one login only ("" when unknown or when it can keep several).
func (s *Service) Unsupported(agent string) string {
	if a, ok := s.Agent(agent); ok {
		return a.AccountUnsupported
	}
	return ""
}
