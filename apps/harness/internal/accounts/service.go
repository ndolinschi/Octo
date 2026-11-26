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
	if _, ok := s.Agent(agent); !ok {
		return ErrUnknownAgent
	}
	if err := s.Store.Remove(agent, id); err != nil {
		return err
	}
	if s.Refresh != nil {
		s.Refresh()
	}
	return nil
}

// Label is the display name of agent, or its id when it is not loaded.
func (s *Service) Label(agent string) string {
	if a, ok := s.Agent(agent); ok && a.Label != "" {
		return a.Label
	}
	return agent
}
