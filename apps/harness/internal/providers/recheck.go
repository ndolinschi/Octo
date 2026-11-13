package providers

import (
	"context"

	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
)

// Recheck runs the agent's login probe now and returns its provider entry
// ("I've logged in: check again"). providers.updated follows when the picture
// changed. ErrUnknownAgent for an id that is not an agent.
func (s *Service) Recheck(ctx context.Context, id string) (Provider, error) {
	if _, ok := s.agent(id); !ok {
		return Provider{}, ErrUnknownAgent
	}
	if s.opts.Recheck != nil {
		s.opts.Recheck(ctx, id)
	}
	s.Refresh()
	p, _ := s.Provider(id)
	return p, nil
}

// CheckFresh is Check for a request about to be refused: when the model's agent
// reads as logged out, its probe is re-run first (unless one ran a moment ago),
// because the user may have logged in since the last one. With force a refusal
// that rests on the login probe alone (Unavailable.CanForce) is let through.
func (s *Service) CheckFresh(ctx context.Context, model string, force bool) *Unavailable {
	u := s.Check(model)
	if u == nil || !u.CanForce {
		return u
	}
	if s.opts.Fresh != nil {
		if id, _, ok := plugins.ParseACPRef(model); ok {
			if _, known := s.opts.Fresh(ctx, id); known {
				s.Refresh()
				u = s.Check(model)
			}
		}
	}
	if u != nil && force && u.CanForce {
		return nil
	}
	return u
}
