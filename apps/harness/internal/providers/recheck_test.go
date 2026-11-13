package providers_test

import (
	"context"
	"sync"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/providers"
)

// loginRig is a service over one agent whose login the test flips; Fresh and
// Recheck count their calls and apply the flipped state, as the registry would
// after a real probe.
type loginRig struct {
	svc            *providers.Service
	mu             sync.Mutex
	loggedIn       *bool // what the agent's probe would say now
	shown          *bool // what the cached result says
	fresh, recheck int
}

func newLoginRig(t *testing.T, available bool) *loginRig {
	t.Helper()
	r := &loginRig{loggedIn: yes(), shown: no()}
	agent := func() plugins.Agent {
		r.mu.Lock()
		defer r.mu.Unlock()
		return plugins.Agent{ID: "grok", Label: "Grok", Available: available, ProbeCommand: "probe", LoggedIn: r.shown, Hint: "Run `grok login`."}
	}
	r.svc = providers.New(providers.Options{
		DataDir: t.TempDir(),
		Builtin: func() (bool, string) { return false, config.NoBuiltinLoopMessage },
		Agents:  func() []plugins.Agent { return []plugins.Agent{agent()} },
		Fresh: func(context.Context, string) (plugins.Agent, bool) {
			r.mu.Lock()
			r.fresh++
			r.shown = r.loggedIn
			r.mu.Unlock()
			return agent(), true
		},
		Recheck: func(context.Context, string) (plugins.Agent, bool) {
			r.mu.Lock()
			r.recheck++
			r.shown = r.loggedIn
			r.mu.Unlock()
			return agent(), true
		},
	})
	return r
}

// Rule 1: logged out in the cache, logged in now: the request passes without
// waiting for the next background probe.
func TestCheckFreshReprobesBeforeRefusing(t *testing.T) {
	r := newLoginRig(t, true)
	if u := r.svc.CheckFresh(context.Background(), "acp:grok", false); u != nil {
		t.Fatalf("refused although the fresh probe passes: %+v", u)
	}
	if r.fresh != 1 {
		t.Fatalf("fresh probes = %d", r.fresh)
	}
	// Still logged out after the fresh probe: refused, and it can be forced.
	r.loggedIn, r.shown = no(), no()
	u := r.svc.CheckFresh(context.Background(), "acp:grok/some-model", false)
	if u == nil || !u.CanForce || u.Provider != "grok" {
		t.Fatalf("refusal = %+v", u)
	}
	if u := r.svc.CheckFresh(context.Background(), "acp:grok", true); u != nil {
		t.Fatalf("forced request refused: %+v", u)
	}
	// A model of a ready provider never triggers a probe.
	r.loggedIn, r.shown = yes(), yes()
	before := r.fresh
	if u := r.svc.CheckFresh(context.Background(), "acp:grok", false); u != nil || r.fresh != before {
		t.Fatalf("ready agent: refusal %+v, probes %d -> %d", u, before, r.fresh)
	}
}

// Rule 4: not_installed (and a built-in path with no key) can never be forced.
func TestNotInstalledAndAPIAreNeverForceable(t *testing.T) {
	r := newLoginRig(t, false)
	u := r.svc.CheckFresh(context.Background(), "acp:grok", true)
	if u == nil || u.CanForce {
		t.Fatalf("not installed, forced = %+v", u)
	}
	if r.fresh != 0 {
		t.Fatal("a missing command is not worth a probe")
	}
	u = r.svc.CheckFresh(context.Background(), "claude-sonnet-5-5", true)
	if u == nil || u.CanForce || u.Provider != "api" {
		t.Fatalf("api, forced = %+v", u)
	}
}

// Rule 3: recheck runs the probe and answers the entry; unknown ids are errors.
func TestRecheckAnswersTheProviderEntry(t *testing.T) {
	r := newLoginRig(t, true)
	p, err := r.svc.Recheck(context.Background(), "grok")
	if err != nil || r.recheck != 1 || p.State != providers.StateReady || p.Login != providers.LoginOK {
		t.Fatalf("recheck = %+v %v (calls %d)", p, err, r.recheck)
	}
	r.loggedIn = no()
	if p, _ = r.svc.Recheck(context.Background(), "grok"); p.State != providers.StateNotLoggedIn {
		t.Fatalf("after logout = %+v", p)
	}
	for _, id := range []string{"nope", "api"} {
		if _, err := r.svc.Recheck(context.Background(), id); err != providers.ErrUnknownAgent {
			t.Fatalf("recheck %q = %v", id, err)
		}
	}
}
