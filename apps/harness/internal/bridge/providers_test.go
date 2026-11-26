package bridge_test

import (
	"context"
	"encoding/json"
	"github.com/ndolinschi/Octo/apps/harness/internal/accounts"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/anthropicclient"
	"github.com/ndolinschi/Octo/apps/harness/internal/bridge"
	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakeacp"
	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/providers"
	"github.com/ndolinschi/Octo/apps/harness/internal/settings"
)

const testKey = "sk-ant-PROVIDERTESTSECRET-0000000"

// provEnv is the stack `harness serve` builds around providers: a key source
// that the settings screen can change, the live built-in-loop switch, the
// provider service and the settings manager, in front of the scripted LLM and
// scripted ACP agents.
type provEnv struct {
	*env
	keys *config.KeySource
	prov *providers.Service
	dir  string // a folder to work in
}

// provDiscovery, when set by a test, turns model discovery on in newProvEnv.
var provDiscovery *providers.Discovery

// agentManifest is a scripted agent with the given extras (models, auth ...).
func agentManifest(id string, extra map[string]any) map[string]any {
	m := map[string]any{
		"id": id, "label": strings.ToUpper(id[:1]) + id[1:], "command": os.Args[0],
		"env": map[string]string{fakeacp.EnvChild: "1", "GORACE": "atexit_sleep_ms=0"},
	}
	for k, v := range extra {
		m[k] = v
	}
	return m
}

// newProvEnv starts the stack. key is the API key in harness.env at start ("":
// none); agents are the plugin agents.
func newProvEnv(t *testing.T, key string, agents ...map[string]any) *provEnv {
	t.Helper()
	data := t.TempDir()
	if len(agents) > 0 {
		writeManifest(t, data, "agents", map[string]any{"name": "agents", "version": "1", "agents": agents})
	}
	reg := plugins.Load(context.Background(), data, nil, nil)
	acctStore := accounts.Open(data)
	reg.SetAccounts(acctStore.List)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	llmSrv := httptest.NewServer(mockllm.New(0))
	t.Cleanup(llmSrv.Close)
	store, err := projectstore.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })

	if key != "" {
		if err := os.WriteFile(filepath.Join(data, config.EnvFileName), []byte("ANTHROPIC_API_KEY="+key+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	keys := config.NewKeySource(key)
	builtin := func() (bool, string) { return config.Config{APIKey: keys.Get()}.BuiltinLoop() }
	_, why := builtin()

	hub := events.NewHub()
	var svcRef atomic.Pointer[project.Service]
	prov := providers.New(providers.Options{
		DataDir: data, Builtin: builtin, Agents: reg.Agents, Recheck: reg.Recheck, Fresh: reg.Fresh, Discovery: provDiscovery,
		Defaults: func() config.Models {
			if s := svcRef.Load(); s != nil {
				return s.Defaults().Models
			}
			return config.BuiltinModels()
		},
		Publish: func(n int) { hub.PublishAll(events.ProvidersUpdated, map[string]any{"connected": n}) },
	})
	t.Cleanup(prov.WaitIdle)
	reg.OnProbeChange(prov.Refresh)
	reg.StartProbes(ctx)

	notes := project.NewNotes(store, hub)
	orch := orchestrator.New(store, hub, notes, orchestrator.Options{
		Client:   anthropicclient.New("", llmSrv.URL, "", anthropicclient.WithKeyFunc(keys.Get)),
		MaxTurns: 12, Stream: true, AgentSource: prov.Agents,
		BuiltinUnavailable: why, DefaultOrchestrator: config.BuiltinModels().Orchestrator,
	})
	t.Cleanup(func() {
		c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = orch.Shutdown(c)
	})
	svc := project.NewService(store, hub, orch, project.Defaults{Models: config.BuiltinModels(), MaxDepth: config.DefaultMaxDepth},
		project.WithACPAgents(prov), project.WithProviders(prov))
	svcRef.Store(svc)
	mgr := settings.New(settings.Options{
		DataDir: data, FromFile: []string{"ANTHROPIC_API_KEY"}, ValidateModels: svc.ValidateModels,
		Lookup: func(string) (string, bool) { return "", false },
		Apply: settings.Applier{
			APIKey: func(k string) {
				keys.Set(k)
				_, w := builtin()
				orch.SetBuiltinUnavailable(w)
			},
			Models: func(o, f, b, d string) { svc.SetDefaultTiers(o, f, b, d); orch.SetDefaultOrchestrator(o) },
		},
		Notify: func(ids []string) {
			hub.PublishAll(events.SettingsChanged, map[string]any{"ids": ids})
			prov.Refresh()
		},
	})
	srv := httptest.NewServer(bridge.New(svc, notes, project.NewFiles(store, hub),
		bridge.WithPlugins(reg), bridge.WithSettings(mgr, true), bridge.WithProviders(prov),
		bridge.WithBuiltinLoopFunc(builtin),
		bridge.WithAccounts(&accounts.Service{Store: acctStore, Agent: reg.Agent, Recheck: prov.Recheck, Refresh: prov.Refresh})))
	t.Cleanup(srv.Close)
	prov.Refresh() // the baseline the first change is measured against

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Demo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return &provEnv{env: &env{url: srv.URL, dir: data}, keys: keys, prov: prov, dir: dir}
}

type provModel struct {
	ID, Label, Source string
	SeenAt            string `json:"seen_at"`
	Stale             bool
}

type provEntry struct {
	ID, Kind, Label, State, Reason string
	InstallHint                    string `json:"install_hint"`
	LoginHint                      string `json:"login_hint"`
	DefaultModel                   string `json:"default_model"`
	FlatRate                       bool   `json:"flat_rate"`
	Models                         []provModel
}

type provResponse struct {
	Connected int
	Suggested struct{ Orchestrator, Fast, Balanced, Deep string }
	Providers []provEntry
}

func (e *provEnv) providers(t *testing.T) provResponse {
	t.Helper()
	var r provResponse
	e.into(t, "GET", "/v1/providers", nil, http.StatusOK, &r)
	return r
}

func (r provResponse) entry(t *testing.T, id string) provEntry {
	t.Helper()
	for _, p := range r.Providers {
		if p.ID == id {
			return p
		}
	}
	t.Fatalf("no provider %q in %+v", id, r.Providers)
	return provEntry{}
}

type apiError struct {
	Error struct{ Code, Message, Provider, Reason, Hint, Command, Action, Details string } `json:"error"`
}

func (e *provEnv) createProject(t *testing.T, models map[string]string, wantStatus int, v any) {
	t.Helper()
	body := map[string]any{"name": "p", "folders": []map[string]string{{"path": e.dir}}}
	if models != nil {
		body["models"] = models
	}
	e.into(t, "POST", "/v1/projects", body, wantStatus, v)
}

func (e *provEnv) putSettings(t *testing.T, body map[string]any) {
	t.Helper()
	status, raw := e.do(t, "PUT", "/v1/settings", body)
	if status != http.StatusOK || strings.Contains(string(raw), testKey) || strings.Contains(string(raw), "PROVIDERTESTSECRET") {
		t.Fatalf("PUT settings = %d %s", status, raw)
	}
}

// notReady is the scripted agent whose login probe says "logged out".
func notLoggedIn(id string) map[string]any {
	return agentManifest(id, map[string]any{
		"auth":    map[string]any{"probe": []string{"sh", "-c", "exit 1"}, "notLoggedInExit": []int{1}, "hint": "Run `" + id + " login` once."},
		"install": "Install " + id + " with your package manager.",
	})
}

func TestProvidersEndpointShape(t *testing.T) {
	e := newProvEnv(t, "",
		agentManifest("grok", nil), agentManifest("zed", nil),
		agentManifest("copilot", map[string]any{"flatRate": true}),
		agentManifest("claude-code", map[string]any{
			"models": []string{"opus", "sonnet"}, "defaultModel": "sonnet", "flatRate": true,
		}),
		agentManifest("ghost", map[string]any{"command": "definitely-not-installed-xyz", "install": "npm i -g ghost"}),
	)
	r := e.providers(t)
	var ids []string
	for _, p := range r.Providers {
		ids = append(ids, p.ID)
	}
	if got := strings.Join(ids, ","); got != "api,claude-code,copilot,grok,zed,ghost" {
		t.Fatalf("order = %s", got)
	}
	if r.Connected != 4 {
		t.Fatalf("connected = %d, want the 4 installed agents", r.Connected)
	}
	api := r.entry(t, "api")
	if api.Kind != "api" || api.State != "not_connected" || api.Reason != "Anthropic API is not connected." || len(api.Models) != 3 ||
		api.Models[0].Source != "catalogue" || api.DefaultModel != "claude-sonnet-5-5" {
		t.Fatalf("api = %+v", api)
	}
	cc := r.entry(t, "claude-code")
	if cc.Kind != "agent" || cc.State != "ready" || !cc.FlatRate || cc.DefaultModel != "sonnet" || len(cc.Models) != 2 ||
		cc.Models[0] != (provModel{ID: "opus", Label: "opus", Source: "manifest"}) {
		t.Fatalf("claude-code = %+v", cc)
	}
	gh := r.entry(t, "ghost")
	if gh.State != "not_installed" || gh.InstallHint != "npm i -g ghost" || gh.Reason == "" {
		t.Fatalf("ghost = %+v", gh)
	}
	// Claude Code first among the ready agents, and it takes every slot.
	if s := r.Suggested; s.Orchestrator != "acp:claude-code" || s.Fast != "acp:claude-code" || s.Deep != "acp:claude-code" {
		t.Fatalf("suggested = %+v", s)
	}
	// The key is write-only: nothing of it in the response, whatever the state.
	if _, raw := e.do(t, "GET", "/v1/providers", nil); strings.Contains(string(raw), "SECRET") {
		t.Fatal("a secret is in /v1/providers")
	}
}

func TestProviderStatesFollowTheLoginProbe(t *testing.T) {
	e := newProvEnv(t, "", notLoggedIn("copilot"))
	waitUntil(t, "the probe result", func() bool { return e.providers(t).entry(t, "copilot").State == "not_logged_in" })
	r := e.providers(t)
	c := r.entry(t, "copilot")
	if c.LoginHint != "Run `copilot login` once." || c.InstallHint == "" || c.Reason != "Copilot is not logged in." {
		t.Fatalf("copilot = %+v", c)
	}
	if r.Connected != 0 || r.Suggested.Orchestrator != "" {
		t.Fatalf("nothing is ready: connected %d, suggested %+v", r.Connected, r.Suggested)
	}
}

func waitUntil(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// A project is a folder and settings: nothing connected does not stop it. The
// stored models are the defaults and the project lists them as unusable.
func TestCreateProjectWithNothingConnectedStillCreates(t *testing.T) {
	e := newProvEnv(t, "")
	var p struct {
		Models  struct{ Orchestrator string }
		Unavail []project.ModelIssue `json:"models_unavailable"`
	}
	e.createProject(t, nil, http.StatusCreated, &p)
	if p.Models.Orchestrator == "" || len(p.Unavail) == 0 {
		t.Fatalf("project = %+v", p)
	}
	e.createProject(t, map[string]string{"orchestrator": "claude-sonnet-5-5"}, http.StatusCreated, &p)
	if p.Models.Orchestrator != "claude-sonnet-5-5" {
		t.Fatalf("orchestrator = %q", p.Models.Orchestrator)
	}
}

func TestCreateProjectUsesTheSuggestedModels(t *testing.T) {
	type proj struct {
		Models  struct{ Orchestrator, Fast, Balanced, Deep string }
		Unavail []project.ModelIssue `json:"models_unavailable"`
		Attn    string               `json:"attention"`
	}
	t.Run("one ready agent is every slot", func(t *testing.T) {
		e := newProvEnv(t, "", agentManifest("claude-code", nil))
		var p proj
		e.createProject(t, nil, http.StatusCreated, &p)
		want := "acp:claude-code"
		if p.Models.Orchestrator != want || p.Models.Fast != want || p.Models.Balanced != want || p.Models.Deep != want {
			t.Fatalf("models = %+v", p.Models)
		}
		if p.Unavail == nil || len(p.Unavail) != 0 || p.Attn != "none" {
			t.Fatalf("unavailable = %v, attention = %q", p.Unavail, p.Attn)
		}
	})
	t.Run("a ready API keeps the current defaults", func(t *testing.T) {
		e := newProvEnv(t, testKey, agentManifest("claude-code", nil))
		var p proj
		e.createProject(t, nil, http.StatusCreated, &p)
		b := config.BuiltinModels()
		if p.Models.Orchestrator != b.Orchestrator || p.Models.Fast != b.Fast || p.Models.Deep != b.Deep {
			t.Fatalf("models = %+v", p.Models)
		}
		// A request that names one non-orchestrator tier model changes only that one.
		e.createProject(t, map[string]string{"deep": "acp:claude-code"}, http.StatusCreated, &p)
		if p.Models.Deep != "acp:claude-code" || p.Models.Orchestrator != b.Orchestrator || p.Models.Fast != b.Fast {
			t.Fatalf("models = %+v", p.Models)
		}
	})
}

// A model whose agent is not logged in, or whose provider is not connected, is
// stored as chosen on create and patch (no refusal); the project lists it under
// models_unavailable so the client can say so and offer the steps.
func TestUnreadyModelsAreStoredOnCreateAndPatch(t *testing.T) {
	e := newProvEnv(t, "", agentManifest("scripted", nil), notLoggedIn("copilot"))
	waitUntil(t, "the probe", func() bool { return e.providers(t).entry(t, "copilot").State == "not_logged_in" })

	type proj struct {
		ID      string
		Models  struct{ Orchestrator, Fast, Deep string }
		Unavail []project.ModelIssue `json:"models_unavailable"`
	}
	var p proj
	e.createProject(t, map[string]string{"orchestrator": "acp:copilot"}, http.StatusCreated, &p)
	if p.Models.Orchestrator != "acp:copilot" || len(p.Unavail) != 4 || p.Unavail[0].Field != "orchestrator" || p.Unavail[0].Provider != "copilot" || p.Unavail[0].Reason != "Copilot is not logged in." {
		t.Fatalf("create = %+v", p)
	}
	// A built-in model with no key: the API is the provider.
	e.createProject(t, map[string]string{"fast": "claude-haiku-5-5"}, http.StatusCreated, &p)
	if p.Models.Fast != "claude-haiku-5-5" || len(p.Unavail) != 1 || p.Unavail[0].Provider != "api" {
		t.Fatalf("create api = %+v", p)
	}

	e.createProject(t, nil, http.StatusCreated, &p)
	if p.Models.Orchestrator != "acp:scripted" {
		t.Fatalf("orchestrator = %q", p.Models.Orchestrator)
	}
	e.into(t, "PATCH", "/v1/projects/"+p.ID, map[string]any{"models": map[string]string{"deep": "acp:copilot"}}, http.StatusOK, &p)
	if p.Models.Deep != "acp:copilot" || len(p.Unavail) != 1 {
		t.Fatalf("patch = %+v", p)
	}
	// An agent that does not exist is a real mistake: still a 400.
	e.wantError(t, "PATCH", "/v1/projects/"+p.ID, map[string]any{"models": map[string]string{"deep": "acp:ghost"}},
		http.StatusBadRequest, "invalid_request")
}

func TestReadingAProjectNeverFailsOnUnusableModels(t *testing.T) {
	e := newProvEnv(t, testKey, agentManifest("scripted", nil))
	var p struct {
		ID      string
		Unavail []project.ModelIssue `json:"models_unavailable"`
	}
	e.createProject(t, nil, http.StatusCreated, &p)
	if len(p.Unavail) != 0 {
		t.Fatalf("unavailable = %+v", p.Unavail)
	}
	// The key goes away: the stored built-in models cannot run any more.
	e.putSettings(t, map[string]any{"unset": []string{"ANTHROPIC_API_KEY"}})
	var got struct {
		Unavail []project.ModelIssue `json:"models_unavailable"`
	}
	e.into(t, "GET", "/v1/projects/"+p.ID, nil, http.StatusOK, &got)
	if len(got.Unavail) != 4 || got.Unavail[0].Field != "orchestrator" || got.Unavail[0].Provider != "api" || got.Unavail[0].Reason == "" {
		t.Fatalf("unavailable = %+v", got.Unavail)
	}
	var list struct{ Projects []struct{ ID string } }
	e.into(t, "GET", "/v1/projects", nil, http.StatusOK, &list)
	if len(list.Projects) != 1 {
		t.Fatalf("projects = %+v", list)
	}
	// And the project is still editable (here: its name).
	e.into(t, "PATCH", "/v1/projects/"+p.ID, map[string]any{"name": "renamed"}, http.StatusOK, nil)
}

func TestAPIKeyMakesTheBuiltinLoopReadyWithoutARestart(t *testing.T) {
	e := newProvEnv(t, "", agentManifest("claude-code", nil))
	ch := func() <-chan sseEvent {
		var p struct{ ID string }
		e.createProject(t, nil, http.StatusCreated, &p) // on the agent: the only thing ready
		return e.subscribe(t, p.ID)
	}()
	if r := e.providers(t); r.entry(t, "api").State != "not_connected" || r.Connected != 1 {
		t.Fatalf("before: %+v", r)
	}
	var cfg struct {
		Builtin struct{ Available bool } `json:"builtin_loop"`
	}
	e.into(t, "GET", "/v1/config", nil, http.StatusOK, &cfg)
	if cfg.Builtin.Available {
		t.Fatal("built-in loop available before the key")
	}

	e.putSettings(t, map[string]any{"set": map[string]any{"ANTHROPIC_API_KEY": testKey}})

	r := e.providers(t)
	if api := r.entry(t, "api"); api.State != "ready" || r.Connected != 2 {
		t.Fatalf("after: %+v", r)
	}
	if r.Suggested.Orchestrator != config.BuiltinModels().Orchestrator {
		t.Fatalf("suggested = %+v", r.Suggested)
	}
	e.into(t, "GET", "/v1/config", nil, http.StatusOK, &cfg)
	if !cfg.Builtin.Available {
		t.Fatal("built-in loop still unavailable after the key")
	}
	var view settings.View
	e.into(t, "GET", "/v1/settings", nil, http.StatusOK, &view)
	if len(view.RestartRequired) != 0 {
		t.Fatalf("restart_required = %v", view.RestartRequired)
	}
	for _, s := range view.Settings {
		if s.ID == "ANTHROPIC_API_KEY" && s.Applies != "now" {
			t.Fatalf("key applies = %q", s.Applies)
		}
	}
	// providers.updated reached the project stream, with the new count.
	ev := waitEvent(t, ch, events.ProvidersUpdated)
	if ev.Data["connected"] != float64(2) {
		t.Fatalf("event = %+v", ev.Data)
	}
}

func waitEvent(t *testing.T, ch <-chan sseEvent, typ string) sseEvent {
	t.Helper()
	timeout := time.After(10 * time.Second)
	for {
		select {
		case ev, ok := <-ch:
			if !ok {
				t.Fatalf("stream ended before %s", typ)
			}
			if ev.Type == typ {
				return ev
			}
		case <-timeout:
			t.Fatalf("timed out waiting for %s", typ)
		}
	}
}

func TestProvidersUpdatedOnlyWhenSomethingChanged(t *testing.T) {
	e := newProvEnv(t, "", agentManifest("claude-code", nil))
	var p struct{ ID string }
	e.createProject(t, nil, http.StatusCreated, &p)
	ch := e.subscribe(t, p.ID)
	// A setting that does not touch providers: settings.changed, no providers.updated.
	e.putSettings(t, map[string]any{"set": map[string]any{"HARNESS_ACP_TRACE": true}})
	// Then one that does (a default model): the suggested models are the same
	// while the API is not ready, so still nothing; the key then changes it.
	e.putSettings(t, map[string]any{"set": map[string]any{"ANTHROPIC_API_KEY": testKey}})
	var types []string
	timeout := time.After(10 * time.Second)
	for done := false; !done; {
		select {
		case ev := <-ch:
			types = append(types, ev.Type)
			done = ev.Type == events.ProvidersUpdated
		case <-timeout:
			t.Fatalf("events = %v", types)
		}
	}
	n := 0
	for _, ty := range types {
		if ty == events.ProvidersUpdated {
			n++
		}
	}
	if n != 1 || types[0] != events.SettingsChanged {
		t.Fatalf("events = %v", types)
	}
}

func TestAdvertisedModelsAreListedAndRemembered(t *testing.T) {
	e := newProvEnv(t, "", agentManifest("scripted", map[string]any{"models": []string{"alpha"}}))
	before := e.providers(t).entry(t, "scripted")
	if len(before.Models) != 1 || before.Models[0].Source != "manifest" {
		t.Fatalf("before = %+v", before.Models)
	}
	// The hook the ACP session code calls.
	e.prov.Record("scripted", []string{"alpha", "beta", "../evil"}, "beta")
	after := e.providers(t).entry(t, "scripted")
	if len(after.Models) != 2 || after.Models[0].ID != "alpha" || after.Models[0].Source != "manifest" || after.Models[0].SeenAt == "" ||
		after.Models[1] != (provModel{ID: "beta", Label: "beta", Source: "advertised", SeenAt: after.Models[1].SeenAt}) || after.Models[1].SeenAt == "" {
		t.Fatalf("after = %+v", after.Models)
	}
	if after.DefaultModel != "beta" {
		t.Fatalf("default = %q (the agent's current model, the manifest names none)", after.DefaultModel)
	}
	// An advertised model can be chosen for a project (manifest ∪ advertised).
	var p struct{ ID string }
	e.createProject(t, map[string]string{"orchestrator": "acp:scripted/beta"}, http.StatusCreated, &p)
	// ... and so can a model nobody listed: the user types it, the agent says whether it knows it.
	e.into(t, "PATCH", "/v1/projects/"+p.ID, map[string]any{"models": map[string]string{"deep": "acp:scripted/gamma"}}, http.StatusOK, nil)
	// The cache is a file in the data directory, readable by the owner only.
	st, err := os.Stat(filepath.Join(e.env.dir, providers.CacheFile))
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("cache file: %v %v", st, err)
	}
	// Later the agent stops advertising beta: it stays, flagged stale.
	e.prov.Record("scripted", []string{"alpha"}, "alpha")
	again := e.providers(t).entry(t, "scripted")
	if len(again.Models) != 2 || again.Models[0].Stale || !again.Models[1].Stale {
		t.Fatalf("again = %+v", again.Models)
	}
}

// failedTurnEnv is a project on the built-in loop whose key then goes away.
func failedTurnEnv(t *testing.T) (*provEnv, string, <-chan sseEvent) {
	t.Helper()
	e := newProvEnv(t, testKey)
	var p struct{ ID string }
	e.createProject(t, nil, http.StatusCreated, &p)
	e.putSettings(t, map[string]any{"unset": []string{"ANTHROPIC_API_KEY"}})
	return e, p.ID, e.subscribe(t, p.ID)
}

type userRows struct {
	users, assistants int
	firstID           int64
}

func (e *provEnv) rows(t *testing.T, pid string) userRows {
	t.Helper()
	var proj struct {
		OrchestratorAgentID string `json:"orchestrator_agent_id"`
	}
	e.into(t, "GET", "/v1/projects/"+pid, nil, http.StatusOK, &proj)
	var m struct {
		Messages []struct {
			ID      int64
			Role    string
			Content []struct{ Type, Text string }
		}
	}
	e.into(t, "GET", "/v1/projects/"+pid+"/agents/"+proj.OrchestratorAgentID+"/messages", nil, http.StatusOK, &m)
	var r userRows
	for _, msg := range m.Messages {
		switch msg.Role {
		case "user":
			if r.users == 0 {
				r.firstID = msg.ID
			}
			r.users++
		case "assistant":
			r.assistants++
		}
	}
	return r
}

func TestRetryOfAFailedTurnReusesTheUserMessage(t *testing.T) {
	e, pid, ch := failedTurnEnv(t)
	post := func() (int64, int) {
		var resp struct {
			Message struct{ ID int64 }
		}
		e.into(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": "quick hello"}, http.StatusAccepted, &resp)
		return resp.Message.ID, 0
	}
	finish := func() turn { return finishTurn(t, ch) }

	id1, _ := post()
	first := finish()
	if first.status != "failed" || !strings.Contains(first.errMsg.(string), "no API key") {
		t.Fatalf("first turn = %s %v", first.status, first.errMsg)
	}
	// The failed state: the project says failed (not needs_you), the error sits on the orchestrator row.
	var proj struct {
		Attention string
		NeedsYou  bool `json:"needs_you"`
		Status    string
	}
	e.into(t, "GET", "/v1/projects/"+pid, nil, http.StatusOK, &proj)
	if proj.Attention != "failed" || proj.NeedsYou || proj.Status != "idle" {
		t.Fatalf("project = %+v", proj)
	}
	var agent struct{ Error *string }
	var pj struct {
		OrchestratorAgentID string `json:"orchestrator_agent_id"`
	}
	e.into(t, "GET", "/v1/projects/"+pid, nil, http.StatusOK, &pj)
	e.into(t, "GET", "/v1/projects/"+pid+"/agents/"+pj.OrchestratorAgentID, nil, http.StatusOK, &agent)
	if agent.Error == nil || !strings.Contains(*agent.Error, "no API key") {
		t.Fatalf("agent error = %v", agent.Error)
	}
	if r := e.rows(t, pid); r.users != 1 {
		t.Fatalf("rows after the failure = %+v", r)
	}

	// Retry (the UI posts the same text again): the stored message is reused,
	// the turn still ends in an error, never a hang.
	id2, _ := post()
	if id2 != id1 {
		t.Fatalf("retry stored message %d, want the existing %d", id2, id1)
	}
	second := finish()
	if second.status != "failed" {
		t.Fatalf("second turn = %s %v", second.status, second.errMsg)
	}
	if r := e.rows(t, pid); r.users != 1 {
		t.Fatalf("rows after the retry = %+v", r)
	}
	if n := count(second.events, events.MessageCreated); n != 0 {
		t.Fatalf("the retry announced %d new messages", n)
	}

	// Connect the key and retry again: the same message gets its answer.
	e.putSettings(t, map[string]any{"set": map[string]any{"ANTHROPIC_API_KEY": testKey}})
	id3, _ := post()
	if id3 != id1 {
		t.Fatalf("third attempt stored message %d, want %d", id3, id1)
	}
	third := finish()
	if third.status != "completed" {
		t.Fatalf("third turn = %s %v", third.status, third.errMsg)
	}
	if r := e.rows(t, pid); r.users != 1 || r.assistants == 0 || r.firstID != id1 {
		t.Fatalf("rows after the answer = %+v", r)
	}
	e.into(t, "GET", "/v1/projects/"+pid, nil, http.StatusOK, &proj)
	if proj.Attention != "none" {
		t.Fatalf("attention after the answer = %q", proj.Attention)
	}
	// A different text after an answered turn is an ordinary new message.
	e.into(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": "quick again"}, http.StatusAccepted, nil)
	finish()
	if r := e.rows(t, pid); r.users != 2 {
		t.Fatalf("rows = %+v", r)
	}
}

func TestFailedTurnPublishesTheFailedAttentionState(t *testing.T) {
	e, pid, ch := failedTurnEnv(t)
	e.into(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": "quick hello"}, http.StatusAccepted, nil)
	var attention []map[string]any
	for _, ev := range collectUntilTurnFinished(t, ch) {
		if ev.Type == events.ProjectAttention {
			attention = append(attention, ev.Data)
		}
	}
	if len(attention) != 1 || attention[0]["state"] != "failed" || attention[0]["needs_you"] != false ||
		!strings.Contains(attention[0]["error"].(string), "no API key") {
		raw, _ := json.Marshal(attention)
		t.Fatalf("attention events = %s", raw)
	}
}
