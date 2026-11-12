package providers_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakeacp"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/providers"
)

func TestMain(m *testing.M) {
	if fakeacp.ChildMode() {
		os.Exit(fakeacp.Main())
	}
	os.Exit(m.Run())
}

type discRig struct {
	svc    *providers.Service
	dir    string
	log    string
	agents []plugins.Agent
	disc   *providers.Discovery

	mu        sync.Mutex
	now       time.Time
	published int
}

// fakeAgent is a scripted agent that logs its requests to log.
func fakeAgentFor(id, log string, env map[string]string) plugins.Agent {
	a := plugins.Agent{ID: id, Label: strings.ToUpper(id[:1]) + id[1:], Available: true, Launch: plugins.Launch{
		Command: os.Args[0], Env: map[string]string{fakeacp.EnvChild: "1", "GORACE": "atexit_sleep_ms=0", fakeacp.EnvRequestLog: log},
	}}
	for k, v := range env {
		a.Env[k] = v
	}
	return a
}

func newDiscRig(t *testing.T, disc *providers.Discovery, mk func(log string) []plugins.Agent) *discRig {
	t.Helper()
	r := &discRig{dir: t.TempDir(), log: filepath.Join(t.TempDir(), "requests.log"), disc: disc,
		now: time.Date(2026, 11, 12, 12, 0, 0, 0, time.UTC)}
	r.agents = mk(r.log)
	r.rebuild()
	t.Cleanup(func() { r.svc.WaitIdle() })
	return r
}

func (r *discRig) clock() time.Time {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.now
}

func (r *discRig) advance(d time.Duration) {
	r.mu.Lock()
	r.now = r.now.Add(d)
	r.mu.Unlock()
}

func (r *discRig) rebuild() {
	r.svc = providers.New(providers.Options{
		DataDir: r.dir, Builtin: func() (bool, string) { return false, config.NoBuiltinLoopMessage },
		Agents:    func() []plugins.Agent { return slices.Clone(r.agents) },
		Defaults:  func() config.Models { return config.BuiltinModels() },
		Now:       r.clock,
		Discovery: r.disc,
		Publish: func(int) {
			r.mu.Lock()
			r.published++
			r.mu.Unlock()
		},
	})
}

func (r *discRig) requests() []string {
	raw, err := os.ReadFile(r.log)
	if err != nil {
		return nil
	}
	return strings.Fields(strings.Join(strings.Split(strings.TrimSpace(string(raw)), "\n"), " "))
}

func (r *discRig) lines() []string {
	raw, _ := os.ReadFile(r.log)
	if len(raw) == 0 {
		return nil
	}
	return strings.Split(strings.TrimSpace(string(raw)), "\n")
}

func (r *discRig) count(prefix string) int {
	n := 0
	for _, l := range r.lines() {
		if strings.HasPrefix(l, prefix) {
			n++
		}
	}
	return n
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if ok() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func modelIDs(p providers.Provider, source string) []string {
	var out []string
	for _, m := range p.Models {
		if m.Source == source {
			out = append(out, m.ID)
		}
	}
	return out
}

func (r *discRig) provider(t *testing.T, id string) providers.Provider {
	t.Helper()
	p, ok := r.svc.Provider(id)
	if !ok {
		t.Fatalf("no provider %q", id)
	}
	return p
}

// An agent that becomes ready is asked for its models without any user request,
// whichever place of the session/new result lists them; no prompt is sent, the
// session lives in an empty temporary directory without MCP servers, and the
// agent is not asked again within the hour.
func TestDiscoveryOnReadyReadsEveryModelListShape(t *testing.T) {
	for _, via := range []string{"models", "config", "config-grouped", "models-array", "meta"} {
		t.Run(via, func(t *testing.T) {
			r := newDiscRig(t, &providers.Discovery{}, func(log string) []plugins.Agent {
				return []plugins.Agent{fakeAgentFor("fake", log, map[string]string{fakeacp.EnvModels: "alpha,beta,gamma", fakeacp.EnvModelsVia: via})}
			})
			r.svc.Refresh() // the agent is ready: discovery starts by itself
			waitFor(t, "models", func() bool { return len(modelIDs(r.provider(t, "fake"), "advertised")) == 3 })
			p := r.provider(t, "fake")
			if !slices.Equal(modelIDs(p, "advertised"), []string{"alpha", "beta", "gamma"}) || (via != "models-array" && p.DefaultModel != "alpha") {
				t.Fatalf("provider = %+v", p)
			}
			waitFor(t, "refreshed_at", func() bool { return r.provider(t, "fake").ModelsRefreshedAt != "" })
			if p := r.provider(t, "fake"); p.ModelsError != "" || !p.AcceptsCustomModel || p.Login != "unchecked" {
				t.Fatalf("provider = %+v", p)
			}
			if r.count("session/prompt") != 0 || r.count("session/new") != 1 {
				t.Fatalf("requests = %q: no prompt, one session", r.lines())
			}
			var cwd string
			for _, l := range r.lines() {
				if strings.HasPrefix(l, "session/new") {
					cwd = strings.Fields(l)[1]
					if !strings.HasSuffix(l, " mcp=0") {
						t.Fatalf("session/new carried MCP servers: %q", l)
					}
				}
			}
			cwd = strings.TrimPrefix(cwd, "cwd=")
			if !strings.Contains(filepath.Base(cwd), "octo-models-") {
				t.Fatalf("cwd = %q, want a fresh temporary directory", cwd)
			}
			if _, err := os.Stat(cwd); !os.IsNotExist(err) {
				t.Fatalf("the temporary directory %q was left behind (%v)", cwd, err)
			}
			// Again within the hour: nothing is started.
			r.advance(59 * time.Minute)
			r.svc.Refresh()
			time.Sleep(150 * time.Millisecond)
			if r.count("session/new") != 1 {
				t.Fatalf("requests = %q: asked again within the hour", r.lines())
			}
			// Forced: now, whatever the last attempt was.
			if _, err := r.svc.RefreshModels(context.Background(), "fake"); err != nil {
				t.Fatal(err)
			}
			if r.count("session/new") != 2 {
				t.Fatalf("requests = %q: a forced refresh must ask", r.lines())
			}
			// After the hour the next ready-check asks again.
			r.advance(2 * time.Hour)
			r.svc.Refresh()
			waitFor(t, "hourly rediscovery", func() bool { return r.count("session/new") == 3 })
		})
	}
}

func TestDiscoveryFailuresAreRecordedNotThrown(t *testing.T) {
	t.Run("agent cannot start", func(t *testing.T) {
		r := newDiscRig(t, &providers.Discovery{}, func(string) []plugins.Agent {
			a := agent("ghost", nil)
			a.Command = "/definitely/not/here"
			return []plugins.Agent{a}
		})
		p, err := r.svc.RefreshModels(context.Background(), "ghost")
		if err != nil || p.ModelsError == "" || p.ModelsRefreshedAt == "" || len(p.Models) != 0 {
			t.Fatalf("p = %+v err = %v", p, err)
		}
	})
	t.Run("not logged in", func(t *testing.T) {
		r := newDiscRig(t, &providers.Discovery{}, func(log string) []plugins.Agent {
			return []plugins.Agent{fakeAgentFor("fake", log, map[string]string{fakeacp.EnvAuth: "interactive"})}
		})
		p, err := r.svc.RefreshModels(context.Background(), "fake")
		if err != nil || !strings.Contains(p.ModelsError, "not logged in") {
			t.Fatalf("p = %+v err = %v", p, err)
		}
	})
	t.Run("agent advertises none", func(t *testing.T) {
		r := newDiscRig(t, &providers.Discovery{}, func(log string) []plugins.Agent {
			return []plugins.Agent{fakeAgentFor("fake", log, nil)}
		})
		p, _ := r.svc.RefreshModels(context.Background(), "fake")
		if p.ModelsError != "the agent advertised no models" {
			t.Fatalf("error = %q", p.ModelsError)
		}
	})
	t.Run("times out", func(t *testing.T) {
		r := newDiscRig(t, &providers.Discovery{Timeout: 300 * time.Millisecond}, func(string) []plugins.Agent {
			a := agent("slow", nil)
			a.Command, a.Args = "sleep", []string{"30"}
			return []plugins.Agent{a}
		})
		start := time.Now()
		p, _ := r.svc.RefreshModels(context.Background(), "slow")
		if p.ModelsError != "timed out after 300ms" || time.Since(start) > 10*time.Second {
			t.Fatalf("error = %q after %v", p.ModelsError, time.Since(start))
		}
	})
	t.Run("a later success clears the error", func(t *testing.T) {
		marker := filepath.Join(t.TempDir(), "login")
		r := newDiscRig(t, &providers.Discovery{}, func(log string) []plugins.Agent {
			return []plugins.Agent{fakeAgentFor("fake", log, map[string]string{
				fakeacp.EnvAuth: "ok", fakeacp.EnvLoginFile: marker, fakeacp.EnvModels: "alpha"})}
		})
		if p, _ := r.svc.RefreshModels(context.Background(), "fake"); p.ModelsError == "" {
			t.Fatalf("p = %+v, want an error before login", p)
		}
		if err := os.WriteFile(marker, nil, 0o600); err != nil {
			t.Fatal(err)
		}
		p, _ := r.svc.RefreshModels(context.Background(), "fake")
		if p.ModelsError != "" || !slices.Equal(modelIDs(p, "advertised"), []string{"alpha"}) {
			t.Fatalf("p = %+v", p)
		}
	})
}

func TestRefreshModelsErrors(t *testing.T) {
	r := newDiscRig(t, &providers.Discovery{}, func(log string) []plugins.Agent {
		return []plugins.Agent{
			fakeAgentFor("fake", log, nil),
			agent("gone", func(a *plugins.Agent) { a.Available = false; a.UnavailableReason = "not found" }),
			agent("out", func(a *plugins.Agent) { a.LoggedIn = no() }),
		}
	})
	if _, err := r.svc.RefreshModels(context.Background(), "nope"); err != providers.ErrUnknownAgent {
		t.Fatalf("unknown: %v", err)
	}
	var nr *providers.NotReadyError
	for _, id := range []string{"gone", "out"} {
		if _, err := r.svc.RefreshModels(context.Background(), id); err == nil || !errorsAs(err, &nr) {
			t.Fatalf("%s: err = %v, want NotReadyError", id, err)
		}
	}
	off := newDiscRig(t, nil, func(log string) []plugins.Agent { return []plugins.Agent{fakeAgentFor("fake", log, nil)} })
	if _, err := off.svc.RefreshModels(context.Background(), "fake"); err != providers.ErrDiscoveryOff {
		t.Fatalf("off: %v", err)
	}
}

func errorsAs(err error, target **providers.NotReadyError) bool {
	nr, ok := err.(*providers.NotReadyError)
	if ok {
		*target = nr
	}
	return ok
}

// While the agent has a live session no process is started: its models are read
// from that session instead.
func TestDiscoverySkipsAnAgentInUse(t *testing.T) {
	var inUse atomic.Bool
	inUse.Store(true)
	live := atomic.Pointer[[]providers.ModelInfo]{}
	list := []providers.ModelInfo{{ID: "live-1", Label: "Live One"}, {ID: "live-2"}}
	live.Store(&list)
	disc := &providers.Discovery{
		InUse: func(string) bool { return inUse.Load() },
		Live:  func(string) ([]providers.ModelInfo, string, bool) { return *live.Load(), "live-1", true },
	}
	r := newDiscRig(t, disc, func(log string) []plugins.Agent {
		return []plugins.Agent{fakeAgentFor("fake", log, map[string]string{fakeacp.EnvModels: "alpha"})}
	})
	p, err := r.svc.RefreshModels(context.Background(), "fake")
	if err != nil {
		t.Fatal(err)
	}
	if len(r.lines()) != 0 {
		t.Fatalf("requests = %q: no process may start while the agent is in use", r.lines())
	}
	if got := modelIDs(p, "advertised"); !slices.Equal(got, []string{"live-1", "live-2"}) || p.Models[0].Label != "Live One" {
		t.Fatalf("models = %+v", p.Models)
	}
	inUse.Store(false)
	if _, err := r.svc.RefreshModels(context.Background(), "fake"); err != nil {
		t.Fatal(err)
	}
	if r.count("session/new") != 1 {
		t.Fatalf("requests = %q", r.lines())
	}
}

func TestModelsCommandIsUsedBeforeASession(t *testing.T) {
	pattern := regexp.MustCompile(`^\s*(?:[-*]\s*)?(grok-[a-z0-9.-]+)(?:\s+\((.*)\))?\s*$`)
	script := "printf 'Available models:\\n  grok-4 (the big one)\\n  - grok-code-fast-1\\nYou are not authenticated.\\n'"
	t.Run("prints models", func(t *testing.T) {
		r := newDiscRig(t, &providers.Discovery{}, func(log string) []plugins.Agent {
			a := fakeAgentFor("grok", log, map[string]string{fakeacp.EnvModels: "session-model"})
			a.ModelsCommand = &plugins.ModelsCommand{Command: "sh", Args: []string{"-c", script}, Pattern: pattern, LabelGroup: 2}
			return []plugins.Agent{a}
		})
		p, err := r.svc.RefreshModels(context.Background(), "grok")
		if err != nil || p.ModelsError != "" {
			t.Fatalf("p = %+v err = %v", p, err)
		}
		if got := modelIDs(p, "command"); !slices.Equal(got, []string{"grok-4", "grok-code-fast-1"}) {
			t.Fatalf("models = %+v", p.Models)
		}
		if p.Models[0].Label != "the big one" || p.Models[1].Label != "grok-code-fast-1" {
			t.Fatalf("labels = %+v", p.Models)
		}
		if len(r.lines()) != 0 {
			t.Fatalf("requests = %q: the command was enough, no session", r.lines())
		}
	})
	t.Run("failing command falls back to the session", func(t *testing.T) {
		r := newDiscRig(t, &providers.Discovery{}, func(log string) []plugins.Agent {
			a := fakeAgentFor("grok", log, map[string]string{fakeacp.EnvModels: "session-model"})
			a.ModelsCommand = &plugins.ModelsCommand{Command: "sh", Args: []string{"-c", "echo nothing useful; exit 3"}, Pattern: pattern}
			return []plugins.Agent{a}
		})
		p, _ := r.svc.RefreshModels(context.Background(), "grok")
		if p.ModelsError != "" || !slices.Equal(modelIDs(p, "advertised"), []string{"session-model"}) || len(modelIDs(p, "command")) != 0 {
			t.Fatalf("p = %+v", p)
		}
	})
	t.Run("both fail: both reasons", func(t *testing.T) {
		r := newDiscRig(t, &providers.Discovery{}, func(log string) []plugins.Agent {
			a := fakeAgentFor("grok", log, nil)
			a.ModelsCommand = &plugins.ModelsCommand{Command: "sh", Args: []string{"-c", "echo x; exit 3"}, Pattern: pattern}
			return []plugins.Agent{a}
		})
		p, _ := r.svc.RefreshModels(context.Background(), "grok")
		if !strings.Contains(p.ModelsError, "models command failed") || !strings.Contains(p.ModelsError, "advertised no models") {
			t.Fatalf("error = %q", p.ModelsError)
		}
	})
}

func TestCustomModels(t *testing.T) {
	r := newRig(t, agent("codex", nil), agent("claude-code", func(a *plugins.Agent) { a.Models = []string{"opus"} }))
	r.svc.Refresh() // the baseline a change is measured against
	base := len(r.events())
	p, err := r.svc.SetCustomModels("codex", []string{"gpt-5.1-codex", "my/model:7b", "gpt-5.1-codex"})
	if err != nil {
		t.Fatal(err)
	}
	if got := modelIDs(p, "custom"); !slices.Equal(got, []string{"gpt-5.1-codex", "my/model:7b"}) {
		t.Fatalf("models = %+v", p.Models)
	}
	if len(r.events()) != base+1 {
		t.Fatalf("providers.updated events = %d, want one more", len(r.events())-base)
	}
	// Persisted in the same per-agent file, and shown after a restart.
	raw, err := os.ReadFile(filepath.Join(r.dir, providers.CacheFile))
	if err != nil || !strings.Contains(string(raw), "gpt-5.1-codex") {
		t.Fatalf("cache = %s (%v)", raw, err)
	}
	r.rebuild()
	if got := modelIDs(byID(t, r.svc.Snapshot(), "codex"), "custom"); len(got) != 2 {
		t.Fatalf("after restart: %v", got)
	}
	// A name already in the manifest list stays a manifest model.
	p, _ = r.svc.SetCustomModels("claude-code", []string{"opus", "sonnet[1m]"})
	if len(p.Models) != 2 || p.Models[0].Source != "manifest" || p.Models[1].Source != "custom" || p.Models[1].ID != "sonnet[1m]" {
		t.Fatalf("models = %+v", p.Models)
	}
	// Removal.
	p, err = r.svc.SetCustomModels("codex", []string{})
	if err != nil || len(p.Models) != 0 {
		t.Fatalf("p = %+v err = %v", p, err)
	}
	// Validation: 1 to 80 characters, no whitespace or control characters.
	for _, bad := range []string{"", "has space", "tab\there", "nl\n", "ctl\x01", strings.Repeat("a", 81), "-leading-dash"} {
		var ve *providers.ValidationError
		if _, err := r.svc.SetCustomModels("codex", []string{"fine", bad}); err == nil || !asValidation(err, &ve) {
			t.Errorf("%q accepted (err = %v)", bad, err)
		}
	}
	if _, err := r.svc.SetCustomModels("codex", []string{strings.Repeat("a", 80)}); err != nil {
		t.Errorf("80 characters must be accepted: %v", err)
	}
	if _, err := r.svc.SetCustomModels("nope", []string{"x"}); err != providers.ErrUnknownAgent {
		t.Errorf("unknown agent: %v", err)
	}
	if got := modelIDs(byID(t, r.svc.Snapshot(), "codex"), "custom"); len(got) != 1 {
		t.Errorf("a rejected list must change nothing: %v", got)
	}
}

func asValidation(err error, target **providers.ValidationError) bool {
	ve, ok := err.(*providers.ValidationError)
	if ok {
		*target = ve
	}
	return ok
}

func TestPrefsAndRoles(t *testing.T) {
	r := newRig(t,
		agent("claude-code", func(a *plugins.Agent) {
			a.Models = []string{"opus", "sonnet", "haiku"}
			a.Roles = map[string]string{"fast": "haiku", "balanced": "sonnet", "deep": "opus"}
		}),
		agent("grok", nil))
	p := byID(t, r.svc.Snapshot(), "claude-code")
	if p.Roles == nil || *p.Roles != (providers.Roles{Fast: "haiku", Balanced: "sonnet", Deep: "opus"}) || p.PreferredModel != "" {
		t.Fatalf("manifest defaults: %+v", p)
	}
	if g := byID(t, r.svc.Snapshot(), "grok"); g.Roles == nil || *g.Roles != (providers.Roles{}) {
		t.Fatalf("grok roles = %+v, want empty (the agent's default)", g.Roles)
	}
	r.svc.Refresh()
	base := len(r.events())
	pref := "opus"
	p, err := r.svc.SetPrefs("claude-code", &pref, map[string]string{"fast": "", "deep": "my-deep-model"})
	if err != nil {
		t.Fatal(err)
	}
	// "" is an explicit "agent default" that overrides the manifest's hint.
	if p.PreferredModel != "opus" || *p.Roles != (providers.Roles{Fast: "", Balanced: "sonnet", Deep: "my-deep-model"}) {
		t.Fatalf("prefs = %+v roles %+v", p.PreferredModel, p.Roles)
	}
	if len(r.events()) != base+1 {
		t.Fatalf("providers.updated events = %d, want one more", len(r.events())-base)
	}
	// The orchestrator sees them on the agents it is given.
	for _, a := range r.svc.Agents() {
		if a.ID == "claude-code" && (a.PreferredModel != "opus" || a.Roles["deep"] != "my-deep-model" || a.Roles["balanced"] != "sonnet" || a.Roles["fast"] != "") {
			t.Fatalf("agent = %+v", a)
		}
	}
	// A partial update keeps the rest; "" clears the preferred model.
	empty := ""
	p, _ = r.svc.SetPrefs("claude-code", &empty, nil)
	if p.PreferredModel != "" || p.Roles.Deep != "my-deep-model" {
		t.Fatalf("p = %+v", p)
	}
	// Survives a restart.
	r.rebuild()
	if q := byID(t, r.svc.Snapshot(), "claude-code"); q.Roles.Deep != "my-deep-model" || q.Roles.Fast != "" {
		t.Fatalf("after restart = %+v", q.Roles)
	}
	// Validated like custom models.
	bad := "has space"
	for name, call := range map[string]func() error{
		"preferred": func() error { _, err := r.svc.SetPrefs("claude-code", &bad, nil); return err },
		"role":      func() error { _, err := r.svc.SetPrefs("claude-code", nil, map[string]string{"fast": bad}); return err },
		"tier":      func() error { _, err := r.svc.SetPrefs("claude-code", nil, map[string]string{"huge": "x"}); return err },
	} {
		var ve *providers.ValidationError
		if err := call(); err == nil || !asValidation(err, &ve) {
			t.Errorf("%s: err = %v, want a validation error", name, err)
		}
	}
	if _, err := r.svc.SetPrefs("api", nil, nil); err != providers.ErrUnknownAgent {
		t.Errorf("api has no prefs: %v", err)
	}
}

// Connected means selectable: only "not installed" and a probe that positively
// says "logged out" make an agent unavailable.
func TestLoginStates(t *testing.T) {
	r := newRig(t,
		agent("noprobe", nil),
		agent("probeok", func(a *plugins.Agent) { a.ProbeCommand, a.LoggedIn = "x", yes() }),
		agent("probeout", func(a *plugins.Agent) { a.ProbeCommand, a.LoggedIn = "x", no() }),
		agent("probeunchecked", func(a *plugins.Agent) { a.ProbeCommand, a.ProbeDone = "x", true }),
		agent("probepending", func(a *plugins.Agent) { a.ProbeCommand = "x" }),
		agent("missing", func(a *plugins.Agent) { a.Available = false }),
	)
	snap := r.svc.Snapshot()
	for id, want := range map[string][2]string{
		"noprobe":        {"ready", "unchecked"},
		"probeok":        {"ready", "ok"},
		"probeout":       {"not_logged_in", "not_logged_in"},
		"probeunchecked": {"ready", "unchecked"},
		"probepending":   {"ready", "unchecked"},
		"missing":        {"not_installed", ""},
	} {
		p := byID(t, snap, id)
		if p.State != want[0] || p.Login != want[1] {
			t.Errorf("%s: state %q login %q, want %v", id, p.State, p.Login, want)
		}
	}
	// A project may be created on an unchecked agent; a logged-out one is refused.
	if u := providers.CheckIn(snap, "acp:noprobe"); u != nil {
		t.Errorf("unchecked agent refused: %+v", u)
	}
	if u := providers.CheckIn(snap, "acp:probeout"); u == nil {
		t.Errorf("a logged-out agent must be refused")
	}
	// JSON: the new fields.
	raw, _ := json.Marshal(byID(t, snap, "noprobe"))
	for _, want := range []string{`"login":"unchecked"`, `"accepts_custom_model":true`, `"roles":{"fast":"","balanced":"","deep":""}`} {
		if !strings.Contains(string(raw), want) {
			t.Errorf("json %s lacks %s", raw, want)
		}
	}
}
