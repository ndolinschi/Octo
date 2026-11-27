package orchestrator

import (
	"context"
	"errors"
	"slices"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
)

// SetOllama swaps the Ollama server URL and small-tier model tag used for
// inline completions; future completion calls see the new values at once.
func (o *Orchestrator) SetOllama(baseURL, model string) {
	url := strings.TrimSpace(baseURL)
	if url == "" {
		url = config.DefaultOllamaBaseURL
	}
	mod := strings.TrimSpace(model)
	o.ollamaURL.Store(&url)
	o.smallModel.Store(&mod)
}

// OllamaConfig returns the live Ollama base URL and small-tier model tag.
func (o *Orchestrator) OllamaConfig() (baseURL, model string) {
	return o.ollamaBaseURL(), o.smallCompletionModel()
}

func (o *Orchestrator) ollamaBaseURL() string {
	if p := o.ollamaURL.Load(); p != nil && strings.TrimSpace(*p) != "" {
		return strings.TrimSpace(*p)
	}
	if strings.TrimSpace(o.opts.OllamaBaseURL) != "" {
		return strings.TrimSpace(o.opts.OllamaBaseURL)
	}
	return config.DefaultOllamaBaseURL
}

func (o *Orchestrator) smallCompletionModel() string {
	if p := o.smallModel.Load(); p != nil {
		if m := strings.TrimSpace(*p); m != "" {
			return m
		}
		return config.DefaultOllamaSmallModel
	}
	if m := strings.TrimSpace(o.opts.SmallCompletionModel); m != "" {
		return m
	}
	return config.DefaultOllamaSmallModel
}

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
	if msg := rt.o.builtinOff(); msg != "" {
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
	if o.builtinOff() == "" || plugins.IsACPRef(model) || model != o.serverDefault() {
		return model
	}
	if a, ok := o.readyAgent(); ok {
		return plugins.ACPPrefix + a.ID
	}
	return model
}

// readyAgent is the first available, logged-in agent in the order claude-code,
// codex, copilot, rest. Only default accounts of agents that are not
// experimental are considered: nothing names the agent, so another account
// (other billing) or an experimental agent is never picked.
func (o *Orchestrator) readyAgent() (plugins.Agent, bool) {
	var ready []plugins.Agent
	for _, a := range o.agents() {
		if a.Available && loggedIn(a) && !isAccount(a) && !a.Experimental {
			ready = append(ready, a)
		}
	}
	for _, id := range preferredAgents {
		if i := slices.IndexFunc(ready, func(a plugins.Agent) bool { return baseOf(a) == id }); i >= 0 {
			return ready[i], true
		}
	}
	if len(ready) > 0 {
		return ready[0], true
	}
	return plugins.Agent{}, false
}

// builtinOff is the reason the built-in loop cannot run right now ("" when it
// can): Options.BuiltinUnavailable until SetBuiltinUnavailable replaces it.
func (o *Orchestrator) builtinOff() string {
	if p := o.builtinReason.Load(); p != nil {
		return *p
	}
	return o.opts.BuiltinUnavailable
}

// SetBuiltinUnavailable swaps the reason the built-in loop cannot run ("" says
// it can): a key written to the settings file makes the loop available
// without a restart. Turns and side questions that start afterwards see it.
func (o *Orchestrator) SetBuiltinUnavailable(reason string) { o.builtinReason.Store(&reason) }

// SetDefaultOrchestrator swaps the server default orchestrator model; turns
// that start afterwards see it. Safe concurrently with running turns.
func (o *Orchestrator) SetDefaultOrchestrator(model string) { o.defaultOrch.Store(&model) }

func (o *Orchestrator) serverDefault() string { return *o.defaultOrch.Load() }

// DefaultOrchestrator is what a project without an explicit orchestrator runs
// on right now (EffectiveOrchestrator of the server default).
func (o *Orchestrator) DefaultOrchestrator() string {
	return o.EffectiveOrchestrator(o.serverDefault())
}

// loggedIn: nothing says the agent is logged out. A probe that has not
// answered, failed to run or printed something unexpected leaves the login
// unchecked, and an unchecked agent can be used.
func loggedIn(a plugins.Agent) bool {
	return a.LoggedIn == nil || *a.LoggedIn
}
