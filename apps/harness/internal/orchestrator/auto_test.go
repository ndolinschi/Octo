package orchestrator_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakerouter"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// autoRun is one turn in which the orchestrator spawns one sub-agent.
type autoRun struct {
	r       *rig
	fr      *fakerouter.Router // nil without a fake router
	pid     string
	status  string
	child   projectstore.Agent
	result  string
	isErr   bool
	events  collected
	schema  []byte
	system  string
	hasKids bool
}

const autoInput = `{"role":"Worker","title":"Find the bug","task":"look at the failing test","tier":"auto"}`

// runAuto runs a turn whose orchestrator spawns one sub-agent with input.
// fo == nil means no router at all. A custom project setup can use setup.
func runAuto(t *testing.T, fo *fakerouter.Options, opts orchestrator.Options, input string, setup func(*rig, string)) *autoRun {
	t.Helper()
	out := &autoRun{}
	var mu sync.Mutex
	llm := fakeLLM(func(w http.ResponseWriter, hr *http.Request, req fakeReq) {
		switch {
		case req.isOrchestrator() && len(req.Msgs) == 1:
			mu.Lock()
			out.system = string(req.System)
			for _, tl := range req.Tools {
				if tl.Name == "spawn_agent" {
					out.schema = tl.InputSchema
				}
			}
			mu.Unlock()
			respond(w, "tool_use", `{"type":"tool_use","id":"t1","name":"spawn_agent","input":`+input+`}`)
		case req.isOrchestrator():
			respond(w, "end_turn", textBlock("done"))
		default:
			respond(w, "end_turn", textBlock("child report"))
		}
	})
	if fo != nil {
		out.r, out.fr = newFakeRig(t, llm, *fo, opts)
	} else {
		out.r = newRigWith(t, llm, opts)
	}
	out.pid = out.r.project(t, 2)
	if setup != nil {
		setup(out.r, out.pid)
	}
	out.events = out.r.runCollect(t, out.pid, "go", nil)
	out.status = out.events.status
	for _, a := range out.r.agents(t, out.pid) {
		if a.ParentID != nil {
			out.child, out.hasKids = a, true
		}
	}
	if out.status == "completed" {
		out.result, out.isErr = orchestratorToolResult(t, out.r, out.pid)
	}
	return out
}

func str(p *string) string {
	if p == nil {
		return "<nil>"
	}
	return *p
}

func routeCaps() *fakerouter.Options { return &fakerouter.Options{Route: &fakerouter.RouteScript{}} }

type routeBody struct {
	BudgetKey string `json:"budget_key"`
	Task      struct {
		Title string   `json:"title"`
		Brief string   `json:"brief"`
		Tools []string `json:"tools"`
		Depth int      `json:"depth"`
	} `json:"task"`
	Candidates []struct {
		ID        string   `json:"id"`
		Kind      string   `json:"kind"`
		Tier      string   `json:"tier"`
		Label     string   `json:"label"`
		FlatRate  *bool    `json:"flat_rate"`
		LoggedIn  *bool    `json:"logged_in"`
		Strengths []string `json:"strengths"`
	} `json:"candidates"`
}

func (a *autoRun) routeBody(t *testing.T) routeBody {
	t.Helper()
	seen := a.fr.RouteRequests()
	if len(seen) != 1 {
		t.Fatalf("route requests = %d, want 1", len(seen))
	}
	var b routeBody
	if err := json.Unmarshal(seen[0].Body, &b); err != nil {
		t.Fatal(err)
	}
	return b
}

func (b routeBody) ids() string {
	var ids []string
	for _, c := range b.Candidates {
		ids = append(ids, c.ID)
	}
	return strings.Join(ids, ",")
}

func TestAutoRoutesToAPITier(t *testing.T) {
	fo := &fakerouter.Options{Route: &fakerouter.RouteScript{
		Choice: "deep", Band: "hard", Reason: "needs careful debugging", Model: "ladder-high", CostUSD: 0.002,
	}}
	a := runAuto(t, fo, orchestrator.Options{}, autoInput, nil)
	if a.status != "completed" || a.isErr {
		t.Fatalf("turn = %s, tool result %q (error=%v)", a.status, a.result, a.isErr)
	}
	c := a.child
	if c.Tier == nil || *c.Tier != projectstore.TierDeep || c.Model != "claude-opus-5-5" || c.Status != projectstore.StatusCompleted {
		t.Fatalf("child = %+v", c)
	}
	if str(c.RouteChoice) != "deep" || str(c.RouteBand) != "hard" || str(c.RouteReason) != "needs careful debugging" || str(c.RouteRequestID) == "<nil>" {
		t.Fatalf("route fields = choice %s band %s reason %s request %s", str(c.RouteChoice), str(c.RouteBand), str(c.RouteReason), str(c.RouteRequestID))
	}

	body := a.routeBody(t)
	if body.BudgetKey != a.pid || body.Task.Title != "Find the bug" || body.Task.Brief != "look at the failing test" || body.Task.Depth != 1 {
		t.Fatalf("route request = %+v", body)
	}
	if body.ids() != "fast,balanced,deep" {
		t.Fatalf("candidates = %s", body.ids())
	}
	for _, c := range body.Candidates {
		if c.Kind != "api" || c.Tier != c.ID {
			t.Fatalf("candidate %+v", c)
		}
	}
	tools := strings.Join(body.Task.Tools, ",")
	if !strings.Contains(tools, "read_file") || !strings.Contains(tools, "run_command") && !strings.Contains(tools, "write_file") || !strings.Contains(tools, "spawn_agent") {
		t.Errorf("task tools = %s", tools)
	}
	if got := a.fr.RouteRequests()[0].Header.Get("x-octo-budget-key"); got != a.pid {
		t.Errorf("budget key header = %q", got)
	}

	// The sub-agent's own requests carry the chosen tier as the hint.
	var hinted bool
	for _, q := range a.fr.Requests() {
		if q.Header.Get("x-octo-agent-role") == "sub" {
			hinted = true
			if q.Header.Get("x-octo-tier-hint") != "deep" || q.Header.Get("x-octo-tier-policy") != "auto" {
				t.Errorf("sub hints = %v", q.Header)
			}
		}
	}
	if !hinted {
		t.Fatal("the sub-agent sent no request")
	}

	// The classifier's cost is a usage row of the spawning agent.
	var rows int
	root := a.r.agents(t, a.pid)[0]
	for _, e := range a.r.usageLog(t, a.pid) {
		if e.Role != projectstore.RoleRoute {
			continue
		}
		rows++
		if e.AgentID != root.ID || e.CostUSD == nil || !near(*e.CostUSD, 0.002) || e.RouterRequestID != str(c.RouteRequestID) ||
			e.Source != projectstore.SourceAPI || e.RouteTrigger != "route" {
			t.Errorf("route usage row = %+v", e)
		}
	}
	if rows != 1 {
		t.Fatalf("route usage rows = %d, want 1", rows)
	}
	if p, err := a.r.svc.Agents(context.Background(), a.pid); err != nil || p[0].InputTokens == 0 {
		t.Fatalf("orchestrator totals missing: %v", err)
	}

	// agent.created carries the decision.
	var created map[string]any
	for _, e := range a.events.of("agent.created") {
		if ag := e["agent"].(map[string]any); ag["id"] == c.ID {
			created = ag
		}
	}
	if created == nil || created["route_reason"] != "needs careful debugging" || created["route_band"] != "hard" ||
		created["route_choice"] != "deep" || created["route_request_id"] != str(c.RouteRequestID) {
		t.Fatalf("agent.created = %v", created)
	}
	if !strings.Contains(a.system, "Leave the tier to auto") {
		t.Errorf("orchestrator prompt lacks the auto guidance")
	}
	var sch struct {
		Properties map[string]struct {
			Enum []string `json:"enum"`
		} `json:"properties"`
		Required []string `json:"required"`
	}
	if err := json.Unmarshal(a.schema, &sch); err != nil {
		t.Fatal(err)
	}
	if strings.Join(sch.Properties["tier"].Enum, ",") != "auto,fast,balanced,deep" || strings.Contains(strings.Join(sch.Required, ","), "tier") {
		t.Fatalf("schema = %s", a.schema)
	}
}

func TestAutoZeroCostRecordWritesNoRow(t *testing.T) {
	fo := &fakerouter.Options{Route: &fakerouter.RouteScript{Choice: "fast", Band: "easy", CostUSD: 0}}
	a := runAuto(t, fo, orchestrator.Options{}, autoInput, nil)
	if a.status != "completed" || str(a.child.RouteChoice) != "fast" {
		t.Fatalf("turn = %s child = %+v", a.status, a.child)
	}
	for _, e := range a.r.usageLog(t, a.pid) {
		if e.Role == projectstore.RoleRoute {
			t.Fatalf("zero-cost route call wrote a usage row: %+v", e)
		}
	}
}

func TestAutoIsTheDefaultTierWithRouteAPI(t *testing.T) {
	a := runAuto(t, routeCaps(), orchestrator.Options{}, `{"role":"Worker","title":"t","task":"x"}`, nil)
	if a.status != "completed" || a.isErr || str(a.child.RouteReason) != "fake router" || a.child.RouteChoice == nil {
		t.Fatalf("turn %s result %q child %+v", a.status, a.result, a.child)
	}
	if len(a.fr.RouteRequests()) != 1 {
		t.Fatalf("route requests = %d", len(a.fr.RouteRequests()))
	}
}

func TestExplicitTierDoesNotRoute(t *testing.T) {
	a := runAuto(t, routeCaps(), orchestrator.Options{}, `{"role":"Worker","title":"t","task":"x","tier":"fast"}`, nil)
	if a.status != "completed" || a.child.RouteChoice != nil || a.child.RouteReason != nil || *a.child.Tier != projectstore.TierFast {
		t.Fatalf("child = %+v", a.child)
	}
	if n := len(a.fr.RouteRequests()); n != 0 {
		t.Fatalf("route requests = %d, want none for an explicit tier", n)
	}
}

func TestAutoRoutesToACPAgent(t *testing.T) {
	flat := fakeAgent("fake", true)
	flat.FlatRate, flat.Strengths = true, []string{"easy", "medium"}
	unknown := fakeAgent("pending", true) // probe configured, no result yet: left out
	unknown.ProbeCommand = "/nonexistent"
	out := fakeAgent("loggedout", true)
	out.ProbeCommand = "/nonexistent"
	no := false
	out.LoggedIn = &no
	gone := fakeAgent("gone", false)

	fo := &fakerouter.Options{Route: &fakerouter.RouteScript{Band: "easy", Reason: "flat-rate agent can do it"}}
	a := runAuto(t, fo, orchestrator.Options{Agents: []plugins.Agent{flat, unknown, out, gone}}, autoInput, nil)
	if a.status != "completed" {
		t.Fatalf("turn = %s (%q)", a.status, a.result)
	}
	body := a.routeBody(t)
	if body.ids() != "fast,balanced,deep,acp:fake,acp:loggedout" {
		t.Fatalf("candidates = %s", body.ids())
	}
	f := body.Candidates[3]
	if f.Kind != "agent" || f.Label != "Fake fake" || f.FlatRate == nil || !*f.FlatRate || f.LoggedIn == nil || !*f.LoggedIn ||
		strings.Join(f.Strengths, ",") != "easy,medium" {
		t.Fatalf("agent candidate = %+v", f)
	}
	if lo := body.Candidates[4]; lo.LoggedIn == nil || *lo.LoggedIn || *lo.FlatRate {
		t.Fatalf("logged-out candidate = %+v", lo)
	}
	c := a.child
	if c.Model != "acp:fake" || c.Tier == nil || *c.Tier != projectstore.TierFast || str(c.RouteChoice) != "acp:fake" ||
		str(c.RouteBand) != "easy" || c.Status != projectstore.StatusCompleted {
		t.Fatalf("child = %+v", c)
	}
}

func TestAutoRouterModelForAgent(t *testing.T) {
	ag := fakeAgent("fake", true)
	ag.Models = []string{"m1", "m2"}
	ag.DefaultModel = "m1"
	fo := &fakerouter.Options{Route: &fakerouter.RouteScript{Choice: "acp:fake", Model: "m2"}}
	a := runAuto(t, fo, orchestrator.Options{Agents: []plugins.Agent{ag}}, autoInput, nil)
	if a.status != "completed" || a.child.Model != "acp:fake/m2" {
		t.Fatalf("turn = %s child model = %q", a.status, a.child.Model)
	}
	// A model the agent does not offer is ignored, not an error.
	fo = &fakerouter.Options{Route: &fakerouter.RouteScript{Choice: "acp:fake", Model: "nope"}}
	a = runAuto(t, fo, orchestrator.Options{Agents: []plugins.Agent{ag}}, autoInput, nil)
	if a.status != "completed" || a.child.Model != "acp:fake/m1" || a.child.RouteChoice == nil || *a.child.RouteChoice != "acp:fake" {
		t.Fatalf("turn = %s child = %+v", a.status, a.child)
	}
}

func TestAutoFallbacks(t *testing.T) {
	for _, tc := range []struct {
		name   string
		fo     *fakerouter.Options
		reason string
	}{
		{"no router", nil, "no router"},
		{"router without route_api", &fakerouter.Options{}, "no router"},
		{"timeout", &fakerouter.Options{Route: &fakerouter.RouteScript{Delay: 3 * time.Second}}, "router did not answer"},
		{"server error", &fakerouter.Options{Route: &fakerouter.RouteScript{Status: 503}}, "router did not answer"},
		{"no candidate", &fakerouter.Options{Route: &fakerouter.RouteScript{Status: 422}}, "no usable candidate"},
		{"rejected", &fakerouter.Options{Route: &fakerouter.RouteScript{Status: 400}}, "did not accept"},
		{"unknown choice", &fakerouter.Options{Route: &fakerouter.RouteScript{Choice: "acp:ghost"}}, `"acp:ghost", which is not a candidate`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := runAuto(t, tc.fo, orchestrator.Options{}, autoInput, nil)
			if a.status != "completed" || a.isErr {
				t.Fatalf("turn = %s, result %q error=%v: a failed route call must not fail the turn", a.status, a.result, a.isErr)
			}
			c := a.child
			if c.Tier == nil || *c.Tier != projectstore.TierBalanced || c.Model != "claude-sonnet-5-5" || c.Status != projectstore.StatusCompleted {
				t.Fatalf("child = %+v", c)
			}
			if !strings.Contains(str(c.RouteReason), tc.reason) || str(c.RouteChoice) != "balanced" || c.RouteBand != nil {
				t.Fatalf("route reason %q choice %s band %s, want reason containing %q", str(c.RouteReason), str(c.RouteChoice), str(c.RouteBand), tc.reason)
			}
		})
	}
}

func TestAutoWithoutRouterKeepsPromptAndRequiresTier(t *testing.T) {
	a := runAuto(t, nil, orchestrator.Options{}, `{"role":"Worker","title":"t","task":"x"}`, nil)
	if !a.isErr || !strings.Contains(a.result, "requires role, title, task and tier (fast|balanced|deep)") || a.hasKids {
		t.Fatalf("result %q error=%v kids=%v: without a router the tier stays required", a.result, a.isErr, a.hasKids)
	}
	if strings.Contains(a.system, "Leave the tier") || !strings.Contains(a.system,
		`- Choose the tier by difficulty: fast for lookups and simple edits, balanced for normal engineering, deep for hard design or debugging.\n- Run independent`) {
		t.Fatalf("prompt changed without a router:\n%s", a.system)
	}
	var sch struct {
		Properties map[string]struct {
			Enum []string `json:"enum"`
		} `json:"properties"`
		Required []string `json:"required"`
	}
	if err := json.Unmarshal(a.schema, &sch); err != nil {
		t.Fatal(err)
	}
	if strings.Join(sch.Properties["tier"].Enum, ",") != "fast,balanced,deep" || strings.Join(sch.Required, ",") != "role,title,task,tier" {
		t.Fatalf("schema changed without a router: %s", a.schema)
	}
}

func TestAutoBudgetReachedFromRouter(t *testing.T) {
	fo := &fakerouter.Options{Route: &fakerouter.RouteScript{Status: 402}}
	a := runAuto(t, fo, orchestrator.Options{}, autoInput, func(r *rig, pid string) { r.update(t, pid, budgetInput(5)) })
	if a.status != "failed" {
		t.Fatalf("turn = %s, want failed on the router's 402", a.status)
	}
	c := a.child
	if c.Status != projectstore.StatusFailed || c.Error == nil || !strings.HasPrefix(*c.Error, "Project budget reached") {
		t.Fatalf("child = %+v", c)
	}
	if str(c.RouteReason) != "router: project budget reached" {
		t.Errorf("route reason = %s", str(c.RouteReason))
	}
	if calls := a.fr.UpstreamCalls(); calls != 1 {
		t.Fatalf("upstream calls = %d, want only the orchestrator's first", calls)
	}
}

func TestAutoCandidatesSetting(t *testing.T) {
	a1, a2 := fakeAgent("a", true), fakeAgent("b", true)
	a2.Models = []string{"fast-m", "slow-m"}
	a2.FlatRate = true
	a := runAuto(t, routeCaps(), orchestrator.Options{Agents: []plugins.Agent{a1, a2}}, autoInput, func(r *rig, pid string) {
		r.svc = r.svcWithAgents(t, a1, a2)
		r.update(t, pid, project.Input{Models: &config.Models{AutoCandidates: []string{"acp:b/slow-m", "deep", "fast"}}})
	})
	body := a.routeBody(t)
	if body.ids() != "acp:b/slow-m,deep,fast" {
		t.Fatalf("candidates = %s, want the setting's order and members", body.ids())
	}
	if c := body.Candidates[0]; c.Label != "Fake b (slow-m)" {
		t.Errorf("label = %q", c.Label)
	}
	// The pinned model is what starts.
	if a.child.Model != "acp:b/slow-m" || str(a.child.RouteChoice) != "acp:b/slow-m" {
		t.Fatalf("child = %+v", a.child)
	}
}

func TestAutoCandidatesValidation(t *testing.T) {
	ag := fakeAgent("a", true)
	r := newACPRig(t, mockllmStub(), ag)
	r.svc = r.svcWithAgents(t, ag)
	pid := r.projectAt(t, t.TempDir())
	for _, bad := range [][]string{{"turbo"}, {"fast", "fast"}, {"acp:ghost"}, {"acp:a/x:::"}} {
		_, err := r.svc.Update(context.Background(), pid, project.Input{Models: &config.Models{AutoCandidates: bad}})
		if err == nil && bad[0] != "acp:a/x:::" {
			t.Errorf("%v accepted", bad)
		}
	}
	p, err := r.svc.Update(context.Background(), pid, project.Input{Models: &config.Models{AutoCandidates: []string{"acp:a", "deep"}}})
	if err != nil || strings.Join(p.Models.AutoCandidates, ",") != "acp:a,deep" {
		t.Fatalf("valid list: %v %v", p.Models.AutoCandidates, err)
	}
	p, err = r.svc.Update(context.Background(), pid, project.Input{Models: &config.Models{AutoCandidates: []string{}}})
	if err != nil || len(p.Models.AutoCandidates) != 0 {
		t.Fatalf("empty list should clear: %v %v", p.Models.AutoCandidates, err)
	}
}

type staticAgents []plugins.Agent

func (s staticAgents) Agents() []plugins.Agent { return s }

// svcWithAgents is the rig's project service validating `acp:` settings
// against agents.
func (r *rig) svcWithAgents(t *testing.T, agents ...plugins.Agent) *project.Service {
	t.Helper()
	return project.NewService(r.store, r.hub, r.orch, project.Defaults{Models: config.DefaultModels(), MaxDepth: 3},
		project.WithACPAgents(staticAgents(agents)))
}

func mockllmStub() http.Handler {
	return fakeLLM(func(w http.ResponseWriter, hr *http.Request, req fakeReq) { respond(w, "end_turn", textBlock("ok")) })
}
