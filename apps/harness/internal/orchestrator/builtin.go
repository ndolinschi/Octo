package orchestrator

import (
	"context"
	"errors"
	"slices"

	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
)

// noBuiltinLoopError is the error a request that needs the built-in agent loop
// ends with while Options.BuiltinUnavailable is set; its text is the option's.
type noBuiltinLoopError struct{ msg string }

func (e noBuiltinLoopError) Error() string { return e.msg }

// IsNoBuiltinLoop reports whether err is the "built-in loop unavailable" error.
func IsNoBuiltinLoop(err error) bool {
	var e noBuiltinLoopError
	return errors.As(err, &e)
}

// loopGate is the gate of every built-in loop (orchestrator turn, sub-agent,
// side question): with no key and no router it fails before any request, so
// nothing reaches the upstream; otherwise it is the budget gate.
func (rt *runtime) loopGate() func(context.Context) error {
	if msg := rt.o.opts.BuiltinUnavailable; msg != "" {
		return func(context.Context) error { return noBuiltinLoopError{msg} }
	}
	return rt.gate()
}

// preferredAgents is the order a default orchestrator is looked for in; agents
// not listed follow in load order.
var preferredAgents = []string{"claude-code", "codex", "copilot"}

// EffectiveOrchestrator is the orchestrator model a project actually runs on
// this turn. It is model itself unless the built-in loop is unavailable and
// model is the server's default (so the project has no explicit choice): then
// it is acp:<id> of the first available, logged-in agent in the order
// claude-code, codex, copilot, rest. "Logged in" means the agent's probe says
// so, or it has no probe. With no such agent the built-in default stays and its
// turn fails with the unavailable message.
func (o *Orchestrator) EffectiveOrchestrator(model string) string {
	if o.opts.BuiltinUnavailable == "" || plugins.IsACPRef(model) || model != o.opts.DefaultOrchestrator {
		return model
	}
	if a, ok := o.readyAgent(); ok {
		return plugins.ACPPrefix + a.ID
	}
	return model
}

// readyAgent is the first available, logged-in agent in the order claude-code,
// codex, copilot, rest.
func (o *Orchestrator) readyAgent() (plugins.Agent, bool) {
	var ready []plugins.Agent
	for _, a := range o.agents() {
		if a.Available && loggedIn(a) {
			ready = append(ready, a)
		}
	}
	for _, id := range preferredAgents {
		if i := slices.IndexFunc(ready, func(a plugins.Agent) bool { return a.ID == id }); i >= 0 {
			return ready[i], true
		}
	}
	if len(ready) > 0 {
		return ready[0], true
	}
	return plugins.Agent{}, false
}

// DefaultOrchestrator is what a project without an explicit orchestrator runs
// on right now (EffectiveOrchestrator of the server default).
func (o *Orchestrator) DefaultOrchestrator() string {
	return o.EffectiveOrchestrator(o.opts.DefaultOrchestrator)
}

// loggedIn: the probe says true, or the agent has no probe.
func loggedIn(a plugins.Agent) bool {
	if a.ProbeCommand == "" {
		return true
	}
	return a.LoggedIn != nil && *a.LoggedIn
}
