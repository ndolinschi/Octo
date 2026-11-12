package orchestrator_test

import (
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakeacp"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakerouter"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// prefAgent is a scripted agent with the user's preferences filled in, as the
// providers service serves it.
func prefAgent() plugins.Agent {
	ag := fakeAgent("fake", true)
	ag.Env[fakeacp.EnvModels] = "alpha,beta,gamma"
	ag.Models = []string{"alpha", "beta", "gamma"}
	ag.DefaultModel = "alpha"
	ag.PreferredModel = "beta"
	ag.Roles = map[string]string{"fast": "gamma", "deep": "alpha"}
	return ag
}

func spawnInput(tier, extra string) string {
	return `{"role":"R","title":"T","task":"do it","tier":"` + tier + `"` + extra + `}`
}

func tierModels(t *testing.T, fast, balanced, deep string) func(*rig, string) {
	return func(r *rig, pid string) {
		r.svc = r.svcWithAgents(t, prefAgent())
		r.update(t, pid, project.Input{Models: &config.Models{Fast: fast, Balanced: balanced, Deep: deep}})
	}
}

// (a) `acp:<agent>` with no model runs on the agent's preferred model, else its
// own default; an explicit model always wins.
func TestPreferredModelWhenNoModelIsNamed(t *testing.T) {
	run := func(t *testing.T, ag plugins.Agent, extra string) string {
		t.Helper()
		a := runAuto(t, nil, orchestrator.Options{Agents: []plugins.Agent{ag}}, spawnInput("balanced", `,"agent":"fake"`+extra), nil)
		if a.status != "completed" || a.child.Status != projectstore.StatusCompleted {
			t.Fatalf("turn = %s child = %+v (%q)", a.status, a.child, a.result)
		}
		return a.child.Model
	}
	if got := run(t, prefAgent(), ""); got != "acp:fake/beta" {
		t.Fatalf("preferred: model = %q", got)
	}
	noPref := prefAgent()
	noPref.PreferredModel = ""
	if got := run(t, noPref, ""); got != "acp:fake/alpha" {
		t.Fatalf("manifest default: model = %q", got)
	}
	noPref.DefaultModel = ""
	if got := run(t, noPref, ""); got != "acp:fake" {
		t.Fatalf("the agent's own default: model = %q", got)
	}
	if got := run(t, prefAgent(), `,"model":"gamma"`); got != "acp:fake/gamma" {
		t.Fatalf("explicit model: %q", got)
	}
}

// The preferred model reaches the agent, and a project whose orchestrator is
// `acp:<agent>` uses it too.
func TestPreferredModelReachesTheAgent(t *testing.T) {
	a := runAuto(t, nil, orchestrator.Options{Agents: []plugins.Agent{prefAgent()}}, spawnInput("balanced", `,"agent":"fake"`), nil)
	if a.child.Result == nil || !strings.Contains(*a.child.Result, "Model in use: beta.") {
		t.Fatalf("result = %v", a.child.Result)
	}
}

// (b) A delegation whose tier is mapped to `acp:<agent>` runs on the role's
// model; with no role on the preferred one; an explicit `acp:<agent>/<model>`
// on the tier always wins.
func TestTierRolesPickTheAgentsModel(t *testing.T) {
	for _, tc := range []struct{ tier, want string }{
		{"fast", "acp:fake/gamma"},    // role fast
		{"balanced", "acp:fake/beta"}, // no role: the preferred model
		{"deep", "acp:fake/zeta"},     // explicit on the project: wins over the role (alpha)
		{"fast-explicit", "acp:fake/zeta"},
	} {
		t.Run(tc.tier, func(t *testing.T) {
			tier, setup := tc.tier, tierModels(t, "acp:fake", "acp:fake", "acp:fake/zeta")
			if tc.tier == "fast-explicit" {
				tier, setup = "fast", tierModels(t, "acp:fake/zeta", "acp:fake", "acp:fake")
			}
			a := runAuto(t, &fakerouter.Options{}, orchestrator.Options{Agents: []plugins.Agent{prefAgent()}}, spawnInput(tier, ""), setup)
			if a.status != "completed" || a.child.Model != tc.want {
				t.Fatalf("turn = %s child model = %q (%q), want %q", a.status, a.child.Model, a.result, tc.want)
			}
			if a.child.Tier == nil || string(*a.child.Tier) != tier {
				t.Fatalf("tier = %v", a.child.Tier)
			}
		})
	}
}

// (b) and (c): a delegation the router decided by difficulty runs on the
// chosen agent with the role of the band, the candidate shows the model it
// would run on, and the usage rows carry the model actually used.
func TestRoutedDelegationUsesRoleModel(t *testing.T) {
	for _, tc := range []struct{ band, want string }{
		{"easy", "acp:fake/gamma"},
		{"medium", "acp:fake/beta"},
		{"hard", "acp:fake/alpha"},
	} {
		t.Run(tc.band, func(t *testing.T) {
			fo := &fakerouter.Options{Route: &fakerouter.RouteScript{Choice: "acp:fake", Band: tc.band}}
			a := runAuto(t, fo, orchestrator.Options{Agents: []plugins.Agent{prefAgent()}}, autoInput, nil)
			if a.status != "completed" || a.child.Model != tc.want {
				t.Fatalf("turn = %s child model = %q (%q), want %q", a.status, a.child.Model, a.result, tc.want)
			}
			if str(a.child.RouteChoice) != "acp:fake" {
				t.Fatalf("route choice = %q", str(a.child.RouteChoice))
			}
			var label string
			for _, c := range a.routeBody(t).Candidates {
				if c.ID == "acp:fake" {
					label = c.Label
				}
			}
			if label != "Fake fake (beta)" {
				t.Fatalf("candidate label = %q, want the preferred model shown", label)
			}
			if rows := usageModels(t, a.r, a.pid, a.child.ID); len(rows) == 0 || rows[0] != tc.want {
				t.Fatalf("usage models = %v, want [%s]", rows, tc.want)
			}
		})
	}
}

// A router-suggested model the manifest does not list is still ignored; the
// user may type any name, the router may not.
func TestRoleModelDoesNotBreakRouterModelHint(t *testing.T) {
	fo := &fakerouter.Options{Route: &fakerouter.RouteScript{Choice: "acp:fake", Band: "easy", Model: "beta"}}
	a := runAuto(t, fo, orchestrator.Options{Agents: []plugins.Agent{prefAgent()}}, autoInput, nil)
	if a.child.Model != "acp:fake/beta" {
		t.Fatalf("model = %q: the router's listed model wins over the band's role", a.child.Model)
	}
}
