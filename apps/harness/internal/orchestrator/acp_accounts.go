package orchestrator

import (
	"fmt"
	"slices"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
)

// isAccount reports whether a is a non-default account of its base agent
// ("claude-code@work"): such an agent is never picked automatically.
func isAccount(a plugins.Agent) bool {
	_, slug := plugins.SplitID(a.ID)
	return slug != ""
}

// baseOf is the manifest agent a runs.
func baseOf(a plugins.Agent) string {
	if a.BaseID != "" {
		return a.BaseID
	}
	base, _ := plugins.SplitID(a.ID)
	return base
}

// namedAgents are the agent ids the project's models name (orchestrator, the
// tiers, side questions and the auto-routing candidates).
func namedAgents(m config.Models) map[string]bool {
	out := map[string]bool{}
	for _, ref := range append([]string{m.Orchestrator, m.Fast, m.Balanced, m.Deep, m.Side}, m.AutoCandidates...) {
		if id, _, ok := plugins.ParseACPRef(ref); ok {
			out[id] = true
		}
	}
	return out
}

// offeredAgents is what a project may hand work to on its own: per base agent
// the accounts the project's models name, and when they name none of them,
// only the base agent's default account. Work and personal billing are the
// user's call, so another account is never offered unasked. An experimental
// agent (manifest experimental, and its accounts) is offered only when the
// models name it.
func offeredAgents(agents []plugins.Agent, m config.Models) []plugins.Agent {
	named := namedAgents(m)
	namedBase := map[string]bool{}
	for _, a := range agents {
		if named[a.ID] {
			namedBase[baseOf(a)] = true
		}
	}
	return slices.DeleteFunc(slices.Clone(agents), func(a plugins.Agent) bool {
		if a.Experimental && !named[a.ID] {
			return true
		}
		if namedBase[baseOf(a)] {
			return !named[a.ID]
		}
		return isAccount(a)
	})
}

// offeredAgents is offeredAgents of the available agents for this project.
func (rt *runtime) offeredAgents() []plugins.Agent {
	return offeredAgents(rt.acpAgents(), rt.models)
}

// pickOfferedAgent is pickACPAgent for an agent the orchestrator named itself
// (spawn_agent's `agent`): it must be one the project offers.
func (rt *runtime) pickOfferedAgent(id, model string) (acpTarget, string) {
	if !slices.ContainsFunc(rt.offeredAgents(), func(a plugins.Agent) bool { return a.ID == id }) {
		return acpTarget{}, fmt.Sprintf("unknown or unavailable ACP agent %q", id)
	}
	return rt.pickACPAgent(id, model)
}
