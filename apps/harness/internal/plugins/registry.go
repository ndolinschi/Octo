package plugins

import (
	"context"
	"slices"
	"time"
)

// Registry is the immutable result of Load; safe for concurrent reads.
type Registry struct {
	plugins []Plugin
	agents  map[string]Agent
	servers map[string]LanguageServer
	probes  *prober
}

// StartProbes turns on background login probing until ctx ends: every agent
// with a probe is checked now and again, at most once a minute, whenever
// Plugins is called. Without it logged_in stays nil.
func (r *Registry) StartProbes(ctx context.Context) {
	if r == nil || r.probes == nil {
		return
	}
	r.probes.mu.Lock()
	r.probes.ctx = ctx
	r.probes.mu.Unlock()
	r.probes.refresh(r.allAgents())
}

// OnProbeChange registers f to be called (from a probe goroutine, no locks
// held) whenever a background login probe finds a different outcome than the
// one before it, the first result included. Call it before StartProbes.
func (r *Registry) OnProbeChange(f func()) {
	if r == nil || r.probes == nil {
		return
	}
	r.probes.mu.Lock()
	r.probes.onChange = f
	r.probes.mu.Unlock()
}

// Recheck runs the agent's login probe now, joining one already running, and
// returns the agent with the fresh result. The second value is false for an
// unknown id.
func (r *Registry) Recheck(ctx context.Context, id string) (Agent, bool) {
	return r.probeNow(ctx, id, 0)
}

// Fresh is Recheck for a request that is about to be refused for a login: it
// probes again unless a probe started less than FreshProbeAge ago, so a user who
// has just logged in is not turned away by an older result.
func (r *Registry) Fresh(ctx context.Context, id string) (Agent, bool) {
	return r.probeNow(ctx, id, FreshProbeAge)
}

func (r *Registry) probeNow(ctx context.Context, id string, minAge time.Duration) (Agent, bool) {
	a, ok := r.Agent(id)
	if !ok {
		return Agent{}, false
	}
	if r.probes != nil && a.probeable() {
		r.probes.sync(ctx, a, minAge)
		a, _ = r.Agent(id)
	}
	return a, true
}

func (r *Registry) allAgents() []Agent {
	var out []Agent
	for _, p := range r.plugins {
		out = append(out, p.Agents...)
	}
	return out
}

func (r *Registry) withState(a Agent) Agent {
	if r.probes != nil && a.probeable() {
		a.LoggedIn = r.probes.result(a.ID)
		a.ProbeDone = r.probes.done(a.ID)
		a.LastReport = r.probes.lastReport(a.ID)
	}
	// An API key forwarded to a subscription agent makes it bill per token.
	a.FlatRate = a.FlatRateIn(a.ResolvedEnv())
	return a
}

// Plugins returns every loaded plugin in load order, including broken ones.
func (r *Registry) Plugins() []Plugin {
	if r == nil {
		return []Plugin{}
	}
	if r.probes != nil {
		r.probes.refresh(r.allAgents())
	}
	out := slices.Clone(r.plugins)
	for i := range out {
		out[i].Agents = r.agentsWithState(out[i].Agents)
	}
	return out
}

func (r *Registry) agentsWithState(in []Agent) []Agent {
	out := make([]Agent, len(in))
	for i, a := range in {
		out[i] = r.withState(a)
	}
	return out
}

// Agents lists every ACP agent in load order, available or not. Like Plugins
// it lets stale login probes refresh in the background.
func (r *Registry) Agents() []Agent {
	out := []Agent{}
	if r == nil {
		return out
	}
	if r.probes != nil {
		r.probes.refresh(r.allAgents())
	}
	for _, p := range r.plugins {
		out = append(out, r.agentsWithState(p.Agents)...)
	}
	return out
}

// Agent looks up an ACP agent by id.
func (r *Registry) Agent(id string) (Agent, bool) {
	if r == nil {
		return Agent{}, false
	}
	a, ok := r.agents[id]
	return r.withState(a), ok
}

// LanguageServers lists every language server in load order.
func (r *Registry) LanguageServers() []LanguageServer {
	out := []LanguageServer{}
	if r == nil {
		return out
	}
	for _, p := range r.plugins {
		out = append(out, p.LanguageServers...)
	}
	return out
}

// LanguageServer looks up a language server by id.
func (r *Registry) LanguageServer(id string) (LanguageServer, bool) {
	if r == nil {
		return LanguageServer{}, false
	}
	s, ok := r.servers[id]
	return s, ok
}

// ToolServers lists the tool server URLs of every valid plugin.
func (r *Registry) ToolServers() []string {
	out := []string{}
	if r == nil {
		return out
	}
	for _, p := range r.plugins {
		for _, ts := range p.ToolServers {
			out = append(out, ts.URL)
		}
	}
	return out
}
