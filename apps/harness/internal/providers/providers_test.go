package providers_test

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/providers"
)

type rig struct {
	svc      *providers.Service
	dir      string
	agents   []plugins.Agent
	builtin  bool
	why      string
	router   bool
	defaults config.Models

	mu        sync.Mutex
	published []int
	now       time.Time
}

type routerFlag struct{ r *rig }

func (f routerFlag) Enabled() bool { return f.r.router }

func newRig(t *testing.T, agents ...plugins.Agent) *rig {
	t.Helper()
	r := &rig{agents: agents, why: config.NoBuiltinLoopMessage, defaults: config.BuiltinModels(), dir: t.TempDir(),
		now: time.Date(2026, 11, 11, 12, 0, 0, 0, time.UTC)}
	r.rebuild()
	return r
}

func (r *rig) rebuild() {
	r.svc = providers.New(providers.Options{
		DataDir: r.dir,
		Builtin: func() (bool, string) {
			if r.builtin {
				return true, ""
			}
			return false, r.why
		},
		Router:   routerFlag{r},
		Agents:   func() []plugins.Agent { return slices.Clone(r.agents) },
		Defaults: func() config.Models { return r.defaults },
		Publish: func(n int) {
			r.mu.Lock()
			r.published = append(r.published, n)
			r.mu.Unlock()
		},
		Now: func() time.Time { return r.now },
	})
}

func (r *rig) events() []int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.published)
}

func yes() *bool { v := true; return &v }
func no() *bool  { v := false; return &v }

func agent(id string, mod func(*plugins.Agent)) plugins.Agent {
	a := plugins.Agent{ID: id, Label: strings.ToUpper(id[:1]) + id[1:], Available: true, Models: []string{}}
	if mod != nil {
		mod(&a)
	}
	return a
}

func byID(t *testing.T, r providers.Response, id string) providers.Provider {
	t.Helper()
	for _, p := range r.Providers {
		if p.ID == id {
			return p
		}
	}
	t.Fatalf("no provider %q", id)
	return providers.Provider{}
}

func TestNothingReady(t *testing.T) {
	r := newRig(t, agent("claude-code", func(a *plugins.Agent) { a.Available = false; a.UnavailableReason = "`claude` was not found" }))
	got := r.svc.Snapshot()
	if got.Connected != 0 || got.Suggested != (providers.Suggested{}) {
		t.Fatalf("snapshot = %+v", got)
	}
	api := byID(t, got, "api")
	if api.Kind != "api" || api.State != "not_connected" || api.Reason != "Anthropic API is not connected." || api.Problem == nil || api.Problem.Details != config.NoBuiltinLoopMessage {
		t.Fatalf("api = %+v", api)
	}
	if cc := byID(t, got, "claude-code"); cc.State != "not_installed" || cc.Problem == nil || !strings.Contains(cc.Problem.Details, "`claude` was not found") {
		t.Fatalf("claude-code = %+v", cc)
	}
	if got.Providers[0].ID != "api" || len(got.Providers) != 2 {
		t.Fatalf("providers = %+v", got.Providers)
	}
}

func TestAPIReadySuggestsTheCurrentDefaults(t *testing.T) {
	r := newRig(t, agent("claude-code", nil))
	r.builtin = true
	r.defaults.Fast = "my-fast-model"
	got := r.svc.Snapshot()
	if got.Connected != 2 {
		t.Fatalf("connected = %d", got.Connected)
	}
	b := config.BuiltinModels()
	want := providers.Suggested{Orchestrator: b.Orchestrator, Fast: "my-fast-model", Balanced: b.Balanced, Deep: b.Deep}
	if got.Suggested != want {
		t.Fatalf("suggested = %+v, want %+v", got.Suggested, want)
	}
	api := byID(t, got, "api")
	if api.State != "ready" || api.Reason != "" || api.DefaultModel != b.Orchestrator || api.FlatRate {
		t.Fatalf("api = %+v", api)
	}
	var ids []string
	for _, m := range api.Models {
		if m.Source != "catalogue" || m.Label == "" {
			t.Fatalf("model = %+v", m)
		}
		ids = append(ids, m.ID)
	}
	if !slices.Equal(ids, []string{"claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "my-fast-model"}) {
		t.Fatalf("models = %v", ids)
	}
}

func TestDefaultsNamingAnUnreadyAgentFallBack(t *testing.T) {
	r := newRig(t, agent("copilot", func(a *plugins.Agent) { a.LoggedIn = no() }))
	r.builtin = true
	r.defaults.Orchestrator = "acp:copilot"
	if got := r.svc.Snapshot().Suggested.Orchestrator; got != config.BuiltinModels().Orchestrator {
		t.Fatalf("orchestrator = %q", got)
	}
}

func TestRouterReplacesTheAPIEntry(t *testing.T) {
	r := newRig(t)
	r.builtin, r.router = true, true
	got := r.svc.Snapshot()
	rt := byID(t, got, "router")
	if rt.Kind != "router" || rt.State != "ready" || len(rt.Models) == 0 {
		t.Fatalf("router = %+v", rt)
	}
	if api := byID(t, got, "api"); api.State != "not_connected" || !strings.Contains(api.Reason, "router") {
		t.Fatalf("api = %+v", api)
	}
	if got.Connected != 1 || got.Suggested.Orchestrator != config.BuiltinModels().Orchestrator {
		t.Fatalf("snapshot = %+v", got)
	}
	if u := r.svc.Check("claude-sonnet-5-5"); u != nil {
		t.Fatalf("check = %+v", u)
	}
}

func TestAgentOrderStatesAndHints(t *testing.T) {
	r := newRig(t,
		agent("zed", nil),
		agent("grok", func(a *plugins.Agent) { a.Available = false; a.InstallHint = "npm i -g grok" }),
		agent("copilot", func(a *plugins.Agent) { a.LoggedIn = no(); a.Hint = "Run `copilot login`."; a.FlatRate = true }),
		agent("claude-code", func(a *plugins.Agent) {
			a.LoggedIn = yes()
			a.Models = []string{"opus", "sonnet"}
			a.DefaultModel = "sonnet"
		}),
		agent("codex", nil),
	)
	got := r.svc.Snapshot()
	var ids []string
	for _, p := range got.Providers {
		ids = append(ids, p.ID)
	}
	if !slices.Equal(ids, []string{"api", "claude-code", "copilot", "grok", "zed", "codex"}) {
		t.Fatalf("order = %v", ids)
	}
	cc, cp, gk := byID(t, got, "claude-code"), byID(t, got, "copilot"), byID(t, got, "grok")
	if cc.State != "ready" || cc.DefaultModel != "sonnet" || len(cc.Models) != 2 {
		t.Fatalf("claude-code = %+v", cc)
	}
	if cp.State != "not_logged_in" || cp.LoginHint != "Run `copilot login`." || !cp.FlatRate || cp.Reason != "Copilot is not logged in." {
		t.Fatalf("copilot = %+v", cp)
	}
	if gk.State != "not_installed" || gk.InstallHint != "npm i -g grok" || gk.Reason != "Grok is not installed." {
		t.Fatalf("grok = %+v", gk)
	}
	if got.Connected != 3 { // claude-code, zed, codex
		t.Fatalf("connected = %d", got.Connected)
	}
	// Claude Code, then Codex, then Copilot, then the rest: the first ready one.
	if got.Suggested.Orchestrator != "acp:claude-code" || got.Suggested.Deep != "acp:claude-code" {
		t.Fatalf("suggested = %+v", got.Suggested)
	}
	r.agents[3].LoggedIn = no()
	if got := r.svc.Snapshot().Suggested.Orchestrator; got != "acp:codex" {
		t.Fatalf("without claude-code: %q", got)
	}
}

func TestAnUnprobedAgentCountsAsReady(t *testing.T) {
	r := newRig(t, agent("claude-code", func(a *plugins.Agent) { a.ProbeCommand = "sh" })) // LoggedIn nil: no result yet
	if got := r.svc.Snapshot(); got.Connected != 1 || got.Suggested.Orchestrator != "acp:claude-code" {
		t.Fatalf("snapshot = %+v", got)
	}
}

func TestCheck(t *testing.T) {
	r := newRig(t,
		agent("claude-code", nil),
		agent("copilot", func(a *plugins.Agent) { a.LoggedIn = no(); a.Hint = "Run `copilot login`." }),
		agent("grok", func(a *plugins.Agent) { a.Available = false; a.InstallHint = "npm i -g grok" }),
	)
	for _, m := range []string{"", "fast", "balanced", "deep", "off", "acp:claude-code", "acp:claude-code/opus"} {
		if u := r.svc.Check(m); u != nil {
			t.Errorf("Check(%q) = %+v", m, u)
		}
	}
	tests := []struct {
		model, provider string
		contain         []string
	}{
		{"claude-sonnet-5-5", "api", []string{"Anthropic API is not connected", "API key"}},
		{"acp:copilot", "copilot", []string{"Copilot is not logged in", "copilot login"}},
		{"acp:grok/x", "grok", []string{"Grok is not installed", "npm i -g grok"}},
		{"acp:ghost", "ghost", []string{"unknown agent"}},
	}
	for _, tc := range tests {
		u := r.svc.Check(tc.model)
		if u == nil || u.Provider != tc.provider {
			t.Fatalf("Check(%q) = %+v", tc.model, u)
		}
		for _, s := range tc.contain {
			if all := u.Reason + " " + u.Problem.Hint + " " + u.Problem.Command + " " + u.Problem.Details; !strings.Contains(all, s) {
				t.Errorf("Check(%q) reason %q lacks %q", tc.model, u.Reason, s)
			}
		}
	}
	r.builtin = true
	if u := r.svc.Check("claude-sonnet-5-5"); u != nil {
		t.Fatalf("with a key: %+v", u)
	}
}

func TestAdvertisedModelsMergeStaleAndPersist(t *testing.T) {
	r := newRig(t, agent("claude-code", func(a *plugins.Agent) { a.Models = []string{"opus", "sonnet"} }), agent("grok", nil))
	r.svc.Record("claude-code", []string{"sonnet", "haiku"}, "haiku")
	r.now = r.now.Add(time.Hour)
	got := byID(t, r.svc.Snapshot(), "claude-code")
	type view struct {
		id, source string
		stale      bool
	}
	var have []view
	for _, m := range got.Models {
		have = append(have, view{m.ID, m.Source, m.Stale})
		if m.Source == "advertised" && m.SeenAt != "2026-11-11T12:00:00Z" {
			t.Fatalf("seen_at = %q", m.SeenAt)
		}
	}
	// opus is in the manifest only: never flagged stale (a manifest alias is the CLI's own name).
	want := []view{{"opus", "manifest", false}, {"sonnet", "manifest", false}, {"haiku", "advertised", false}}
	if !slices.Equal(have, want) {
		t.Fatalf("models = %+v, want %+v", have, want)
	}
	if got.DefaultModel != "haiku" {
		t.Fatalf("default = %q (the manifest names none: the agent's current)", got.DefaultModel)
	}
	// An agent whose manifest lists models accepts the advertised ones too.
	for _, a := range r.svc.Agents() {
		if a.ID == "claude-code" && !slices.Equal(a.Models, []string{"opus", "sonnet", "haiku"}) {
			t.Fatalf("Agents() models = %v", a.Models)
		}
		if a.ID == "grok" && len(a.Models) != 0 {
			t.Fatalf("grok models = %v", a.Models)
		}
	}
	// A later session no longer advertises sonnet: it stays, flagged.
	r.svc.Record("claude-code", []string{"kite"}, "kite")
	got = byID(t, r.svc.Snapshot(), "claude-code")
	for _, m := range got.Models {
		if m.ID == "haiku" && !m.Stale {
			t.Fatalf("haiku = %+v", m)
		}
		if (m.ID == "kite" || m.Source == "manifest") && m.Stale {
			t.Fatalf("%s = %+v", m.ID, m)
		}
	}

	// The cache survives a restart, owner-only.
	path := filepath.Join(r.dir, providers.CacheFile)
	if st, err := os.Stat(path); err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("cache: %v %v", st, err)
	}
	r.rebuild()
	again := byID(t, r.svc.Snapshot(), "claude-code")
	if len(again.Models) != 4 || again.Models[2].ID != "kite" || again.Models[2].SeenAt == "" {
		t.Fatalf("after restart = %+v", again.Models)
	}
}

func TestRecordIgnoresJunk(t *testing.T) {
	r := newRig(t, agent("claude-code", nil))
	r.svc.Record("claude-code", nil, "")
	r.svc.Record("claude-code", []string{"", "-rf", "a b", "../x", "ok-1"}, "../current")
	got := byID(t, r.svc.Snapshot(), "claude-code")
	if len(got.Models) != 1 || got.Models[0].ID != "ok-1" || got.DefaultModel != "" {
		t.Fatalf("models = %+v default %q", got.Models, got.DefaultModel)
	}
	// A corrupt cache file is ignored, not fatal.
	if err := os.WriteFile(filepath.Join(r.dir, providers.CacheFile), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	r.rebuild()
	if got := byID(t, r.svc.Snapshot(), "claude-code"); len(got.Models) != 0 {
		t.Fatalf("models = %+v", got.Models)
	}
}

func TestRefreshPublishesOnlyOnChange(t *testing.T) {
	r := newRig(t, agent("claude-code", nil))
	r.svc.Refresh() // baseline: no event
	r.svc.Refresh()
	if len(r.events()) != 0 {
		t.Fatalf("events = %v", r.events())
	}
	r.builtin = true
	r.svc.Refresh()
	if !slices.Equal(r.events(), []int{2}) {
		t.Fatalf("events = %v", r.events())
	}
	r.svc.Refresh()
	if len(r.events()) != 1 {
		t.Fatalf("an unchanged picture published: %v", r.events())
	}
	// A login probe turning false.
	r.agents[0].LoggedIn = no()
	r.svc.Refresh()
	if !slices.Equal(r.events(), []int{2, 1}) {
		t.Fatalf("events = %v", r.events())
	}
	// A default model changing changes the suggestion.
	r.defaults.Deep = "claude-opus-5-6"
	r.svc.Refresh()
	if len(r.events()) != 3 {
		t.Fatalf("events = %v", r.events())
	}
	// Models advertised for the first time publish; the same models later (only
	// a newer seen_at) do not.
	r.svc.Record("claude-code", []string{"a", "b"}, "a")
	if len(r.events()) != 4 {
		t.Fatalf("events = %v", r.events())
	}
	r.now = r.now.Add(time.Hour)
	r.svc.Record("claude-code", []string{"a", "b"}, "a")
	if len(r.events()) != 4 {
		t.Fatalf("a re-advertisement published: %v", r.events())
	}
}
