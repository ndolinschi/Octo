package providers

import (
	"fmt"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// unavailable is the refusal for a provider that is not ready: its catalogue
// problem (not logged in, not installed, ...) with Reason as its plain message.
func unavailable(p Provider, canForce bool) *Unavailable {
	prob := p.Problem
	if prob == nil {
		switch p.State {
		case StateError:
			prob = usererr.ProviderNotWorking(p.Label, p.Reason)
		default:
			prob = usererr.ProviderNotConnected(p.Label, "", p.Reason)
		}
	}
	return &Unavailable{Provider: p.ID, Reason: prob.Message, CanForce: canForce, Problem: prob}
}

// modelsProblem is why the agent's models could not be listed, in the
// catalogue's form; text is the short technical line the lookup left.
func modelsProblem(label string, a plugins.Agent, text string) *usererr.Error {
	if strings.Contains(strings.ToLower(text), "not logged in") {
		return usererr.AgentNotLoggedIn(label, a.LoginCmd(), a.Hint)
	}
	return usererr.ModelsLookupFailed(label, text)
}

// unknownAgent is the refusal for an `acp:<id>` whose agent is not loaded.
func unknownAgent(id string) *Unavailable {
	prob := usererr.AgentUnavailable(fmt.Sprintf("unknown agent %q", id))
	return &Unavailable{Provider: id, Reason: prob.Message, Problem: prob}
}
