package plugins

import (
	"context"
	"fmt"
	"slices"
	"sync"
	"time"
)

// Registry is the immutable result of Load; safe for concurrent reads.
type Registry struct {
	plugins []Plugin
	agents  map[string]Agent
	servers map[string]LanguageServer
	probes  *prober
	// versions caches the version checks of agents whose manifest has one.
	versions *versioner
	// seenOut holds the agents a real session found not logged in (R5-4): an
	// agent without a reliable login probe (Copilot has none; Grok's lists
	// models without a login) otherwise keeps reading ready.
	seenMu  sync.Mutex
	seenOut map[string]bool
	// accounts lists the user's extra agent accounts (SetAccounts); each is
	// served as an agent of its own, "<agent>@<account>".
	acctMu   sync.RWMutex
	accounts func() []Account
}

// SeenLogin records what a real session of the agent found: ok=false (it
// refused for a missing login) shows the agent not logged in until a later
// session starts fine or its login is checked again (Recheck). It reports
// whether the recorded state changed.
func (r *Registry) SeenLogin(id string, ok bool) bool {
	if r == nil {
		return false
	}
	r.seenMu.Lock()
	defer r.seenMu.Unlock()
	if r.seenOut[id] == !ok {
		return false
	}
	if ok {
		delete(r.seenOut, id)
	} else {
		if r.seenOut == nil {
			r.seenOut = map[string]bool{}
		}
		r.seenOut[id] = true
	}
	return true
}

func (r *Registry) seenLoggedOut(id string) bool {
	r.seenMu.Lock()
	defer r.seenMu.Unlock()
	return r.seenOut[id]
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
	if r.versions != nil {
		r.versions.mu.Lock()
		r.versions.ctx = ctx
		r.versions.mu.Unlock()
		r.versions.refresh(r.baseAgents())
	}
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
	if r.versions != nil {
		r.versions.mu.Lock()
		r.versions.onChange = f
		r.versions.mu.Unlock()
	}
}

// Recheck runs the agent's login probe (and its version check, when the
// manifest has one) now, joining one already running, and returns the agent
// with the fresh result. The second value is false for an
// unknown id.
func (r *Registry) Recheck(ctx context.Context, id string) (Agent, bool) {
	r.SeenLogin(id, true) // the user asks again: the probe (or, without one, the next session) decides
	if r != nil && r.versions != nil {
		if raw, ok := r.agents[versionKey(id)]; ok {
			r.versions.sync(ctx, raw)
		}
	}
	return r.probeNow(ctx, id, 0)
}

// Fresh is Recheck for a request that is about to be refused for a login: it
// probes again unless a probe started less than FreshProbeAge ago, so a user who
// has just logged in is not turned away by an older result.
func (r *Registry) Fresh(ctx context.Context, id string) (Agent, bool) {
	r.SeenLogin(id, true) // a new attempt: the probe and that session decide again
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

// refreshAll lets stale login probes and version checks rerun in the background.
func (r *Registry) refreshAll() {
	if r.probes != nil {
		r.probes.refresh(r.allAgents())
	}
	if r.versions != nil {
		r.versions.refresh(r.baseAgents())
	}
}

// allAgents is every agent with the agents of the user's accounts.
func (r *Registry) allAgents() []Agent { return r.withAccounts(r.baseAgents()) }

// baseAgents is every agent of the manifests, without accounts.
func (r *Registry) baseAgents() []Agent {
	var out []Agent
	for _, p := range r.plugins {
		out = append(out, p.Agents...)
	}
	return out
}

// versionKey is the agent whose version check id uses: an account runs its
// base agent's program, checked once for both.
func versionKey(id string) string {
	if base, _, ok := SplitAccountID(id); ok {
		return base
	}
	return id
}

func (r *Registry) withState(a Agent) Agent {
	if r.probes != nil && a.probeable() {
		a.LoggedIn = r.probes.result(a.ID)
		a.ProbeDone = r.probes.done(a.ID)
		a.LastReport = r.probes.lastReport(a.ID)
	}
	if r.versions != nil && a.HasVersionCheck() {
		a.Version = r.versions.report(versionKey(a.ID))
		if a.Version.TooOld && a.Available {
			a.VersionTooOld, a.Available = true, false
			a.UnavailableReason = fmt.Sprintf("%s %s is installed; Octo needs %s or newer", baseName(a.Command), a.Version.Version, a.MinVersion)
		}
	}
	if a.Available && r.seenLoggedOut(a.ID) {
		f := false
		a.LoggedIn = &f
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
	r.refreshAll()
	out := slices.Clone(r.plugins)
	for i := range out {
		out[i].Agents = r.agentsWithState(r.withAccounts(out[i].Agents))
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
	r.refreshAll()
	for _, p := range r.plugins {
		out = append(out, r.agentsWithState(r.withAccounts(p.Agents))...)
	}
	return out
}

// Agent looks up an ACP agent by id.
func (r *Registry) Agent(id string) (Agent, bool) {
	if r == nil {
		return Agent{}, false
	}
	a, ok := r.agents[id]
	if !ok {
		if a, ok = r.accountAgent(id); !ok {
			return Agent{}, false
		}
	}
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
