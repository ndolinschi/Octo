package orchestrator_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/fakerouter"
	"github.com/ndolinschi/Octo/apps/harness/internal/features"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// escalateOn is a feature store with delegation.escalate_on_failure = once.
func escalateOn() *features.Store {
	return features.NewStore(func(k string) (string, bool) {
		if k == "HARNESS_DELEGATION_ESCALATE_ON_FAILURE" {
			return "1", true
		}
		return "", false
	})
}

// waitOutcomes polls the fake router until it has seen n outcome reports.
func waitOutcomes(t *testing.T, fr *fakerouter.Router, n int) []fakerouter.OutcomeSeen {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		got := fr.Outcomes()
		if len(got) >= n {
			return got
		}
		if time.Now().After(deadline) {
			t.Fatalf("outcome reports = %d, want %d: %+v", len(got), n, got)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func outcomesOf(seen []fakerouter.OutcomeSeen, id, event string) []map[string]any {
	var out []map[string]any
	for _, s := range seen {
		if s.RequestID == id && s.Body["event"] == event {
			out = append(out, s.Body)
		}
	}
	return out
}

type delegationRun struct {
	r      *rig
	fr     *fakerouter.Router
	pid    string
	kids   []projectstore.Agent
	result string
	isErr  bool
}

// runDelegation runs one turn: the orchestrator spawns input once (or each of
// inputs in turn), the sub-agent answers with child(model).
func runDelegation(t *testing.T, script fakerouter.RouteScript, opts orchestrator.Options, child func(model string) string, inputs ...string) *delegationRun {
	t.Helper()
	llm := fakeLLM(func(w http.ResponseWriter, hr *http.Request, req fakeReq) {
		switch {
		case req.isOrchestrator() && len(req.Msgs) <= 2*len(inputs)-1:
			i := len(req.Msgs) / 2
			respond(w, "tool_use", `{"type":"tool_use","id":"t`+string(rune('1'+i))+`","name":"spawn_agent","input":`+inputs[i]+`}`)
		case req.isOrchestrator():
			respond(w, "end_turn", textBlock("done"))
		default:
			respond(w, "end_turn", textBlock(child(req.Model)))
		}
	})
	out := &delegationRun{}
	out.r, out.fr = newFakeRig(t, llm, fakerouter.Options{Route: &script}, opts)
	out.pid = out.r.project(t, 2)
	if st := out.r.runCollect(t, out.pid, "go", nil).status; st != "completed" {
		t.Fatalf("turn status = %s", st)
	}
	for _, a := range out.r.agents(t, out.pid) {
		if a.ParentID != nil {
			out.kids = append(out.kids, a)
		}
	}
	out.result, out.isErr = orchestratorToolResult(t, out.r, out.pid)
	return out
}

const fixInput = `{"role":"Worker","title":"Fix the parser","task":"make the parser accept trailing commas","tier":"auto"}`

func TestRoutedDelegationReportsItsOutcomeToTheRouter(t *testing.T) {
	d := runDelegation(t, fakerouter.RouteScript{Choice: "fast"}, orchestrator.Options{},
		func(string) string { return "Done: the parser accepts trailing commas." }, fixInput)
	if len(d.kids) != 1 || d.kids[0].RouteRequestID == nil {
		t.Fatalf("kids = %+v", d.kids)
	}
	child := d.kids[0]
	seen := waitOutcomes(t, d.fr, 1)
	got := outcomesOf(seen, *child.RouteRequestID, "finished")
	if len(got) != 1 {
		t.Fatalf("finished reports for %s = %+v", *child.RouteRequestID, seen)
	}
	o := got[0]
	if o["report_id"] != child.ID+":finished" || o["status"] != "completed" || o["agent_signal"] != "done" ||
		o["session_id"] != child.ID || o["duration_ms"] == nil {
		t.Fatalf("report = %+v", o)
	}
	u, _ := o["usage"].(map[string]any)
	if u["turns"].(float64) < 1 || u["input_tokens"].(float64) <= 0 || u["cost_usd"] == nil {
		t.Fatalf("usage = %+v", u)
	}
	// The route request said which session and which parent tier the delegation came from.
	var body struct {
		SessionID string `json:"session_id"`
		Task      struct {
			ParentTier string `json:"parent_tier"`
		} `json:"task"`
	}
	_ = json.Unmarshal(d.fr.RouteRequests()[0].Body, &body)
	if body.SessionID == "" || body.Task.ParentTier == "" {
		t.Fatalf("route body = %s", d.fr.RouteRequests()[0].Body)
	}
}

func TestACouldNotOnACheapCandidateEscalatesOnceWhenThePolicyAllows(t *testing.T) {
	script := fakerouter.RouteScript{Choice: "fast", Retry: &fakerouter.RouteScript{Reason: "fake retry"}}
	// The fake router serves "mid" under the auto tier policy whatever the hint,
	// so the first sub-agent is told apart by order: it is the one that fails.
	var calls atomic.Int32
	d := runDelegation(t, script, orchestrator.Options{Features: escalateOn()}, func(model string) string {
		if calls.Add(1) == 1 {
			return "Could not do it: the grammar is beyond me."
		}
		return "Done on " + model + "."
	}, fixInput)
	if len(d.kids) != 2 {
		t.Fatalf("sub-agents = %d, want 2 (first attempt and one retry)", len(d.kids))
	}
	first, second := d.kids[0], d.kids[1]
	if first.Status != projectstore.StatusCompleted || second.Status != projectstore.StatusCompleted {
		t.Fatalf("statuses = %s, %s", first.Status, second.Status)
	}
	if str(second.RouteChoice) != "balanced" || !strings.HasPrefix(str(second.RouteReason), "Retried on the balanced tier after it reported it could not do the task.") {
		t.Fatalf("retry row: choice %s reason %q", str(second.RouteChoice), str(second.RouteReason))
	}
	if second.Task != first.Task {
		t.Fatalf("the retry got another brief: %q", second.Task)
	}
	reqs := d.fr.RouteRequests()
	if len(reqs) != 2 {
		t.Fatalf("route requests = %d", len(reqs))
	}
	var retry struct {
		Attempt       int      `json:"attempt"`
		EscalatedFrom string   `json:"escalated_from"`
		Exclude       []string `json:"exclude"`
		MinTier       string   `json:"min_tier"`
	}
	_ = json.Unmarshal(reqs[1].Body, &retry)
	if retry.Attempt != 2 || retry.EscalatedFrom != *first.RouteRequestID || len(retry.Exclude) != 1 ||
		retry.Exclude[0] != "fast" || retry.MinTier != "balanced" {
		t.Fatalf("retry request = %s", reqs[1].Body)
	}
	seen := waitOutcomes(t, d.fr, 3)
	if f := outcomesOf(seen, *first.RouteRequestID, "finished"); len(f) != 1 || f[0]["agent_signal"] != "could_not" {
		t.Fatalf("first finished = %+v", f)
	}
	esc := outcomesOf(seen, *first.RouteRequestID, "escalated")
	if len(esc) != 1 || esc[0]["by"] != *second.RouteRequestID || esc[0]["reason"] != "could_not" {
		t.Fatalf("escalated = %+v", esc)
	}
	if f := outcomesOf(seen, *second.RouteRequestID, "finished"); len(f) != 1 || f[0]["status"] != "completed" {
		t.Fatalf("second finished = %+v", f)
	}
	if d.isErr || !strings.Contains(d.result, "retried once on the balanced tier") || !strings.Contains(d.result, "Done on "+fakerouter.Ladder["mid"]) {
		t.Fatalf("tool result = %q (err %v)", d.result, d.isErr)
	}
}

func TestAFailedRetryIsNotEscalatedAgain(t *testing.T) {
	script := fakerouter.RouteScript{Choice: "fast", Retry: &fakerouter.RouteScript{}}
	d := runDelegation(t, script, orchestrator.Options{Features: escalateOn()},
		func(string) string { return "Could not do it: nothing works." }, fixInput)
	if len(d.kids) != 2 || len(d.fr.RouteRequests()) != 2 {
		t.Fatalf("sub-agents = %d, route requests = %d; want exactly one retry", len(d.kids), len(d.fr.RouteRequests()))
	}
}

func TestEscalationIsOffByDefault(t *testing.T) {
	script := fakerouter.RouteScript{Choice: "fast", Retry: &fakerouter.RouteScript{}}
	d := runDelegation(t, script, orchestrator.Options{},
		func(string) string { return "Could not do it: the grammar is beyond me." }, fixInput)
	if len(d.kids) != 1 || len(d.fr.RouteRequests()) != 1 {
		t.Fatalf("sub-agents = %d, route requests = %d", len(d.kids), len(d.fr.RouteRequests()))
	}
	seen := waitOutcomes(t, d.fr, 1)
	if f := outcomesOf(seen, *d.kids[0].RouteRequestID, "finished"); len(f) != 1 || f[0]["agent_signal"] != "could_not" {
		t.Fatalf("finished = %+v", seen)
	}
}

func TestTheRoutersFailingTestsLabelEscalatesACompletedRun(t *testing.T) {
	script := fakerouter.RouteScript{Choice: "fast", Label: "no", Rule: "tests_failed", Retry: &fakerouter.RouteScript{}}
	d := runDelegation(t, script, orchestrator.Options{Features: escalateOn()},
		func(string) string { return "Done, but cargo test still fails." }, fixInput)
	if len(d.kids) != 2 || !strings.Contains(str(d.kids[1].RouteReason), "after its last test run failed") {
		t.Fatalf("kids = %d, reason %q", len(d.kids), str(d.kids[len(d.kids)-1].RouteReason))
	}
}

func TestNothingStrongerMeansNoEscalation(t *testing.T) {
	script := fakerouter.RouteScript{Choice: "deep", Retry: &fakerouter.RouteScript{}}
	d := runDelegation(t, script, orchestrator.Options{Features: escalateOn()},
		func(string) string { return "Could not do it." }, fixInput)
	if len(d.kids) != 1 || len(d.fr.RouteRequests()) != 1 {
		t.Fatalf("the deep tier was escalated: kids %d, route requests %d", len(d.kids), len(d.fr.RouteRequests()))
	}
}

func TestARouterThatDropsOutcomesChangesNothing(t *testing.T) {
	d := runDelegation(t, fakerouter.RouteScript{Choice: "fast", OutcomeStatus: http.StatusServiceUnavailable},
		orchestrator.Options{}, func(string) string { return "Done." }, fixInput)
	if len(d.kids) != 1 || d.kids[0].Status != projectstore.StatusCompleted || d.isErr {
		t.Fatalf("kids = %+v err %v", d.kids, d.isErr)
	}
}

func TestTheSameTaskDelegatedAgainMarksTheEarlierOneRedelegated(t *testing.T) {
	again := `{"role":"Worker","title":"Fix the parser","task":"make the parser accept trailing commas, really","tier":"auto"}`
	d := runDelegation(t, fakerouter.RouteScript{Choice: "fast"}, orchestrator.Options{},
		func(string) string { return "Done." }, fixInput, again)
	if len(d.kids) != 2 {
		t.Fatalf("kids = %d", len(d.kids))
	}
	seen := waitOutcomes(t, d.fr, 3)
	redo := outcomesOf(seen, *d.kids[0].RouteRequestID, "redelegated")
	if len(redo) != 1 || redo[0]["by"] != *d.kids[1].RouteRequestID || redo[0]["after_failure"] != false {
		t.Fatalf("redelegated = %+v (all: %+v)", redo, seen)
	}
}

func TestAnACPSubAgentTheRouterChoseReportsItsOutcomeWithoutARouterSession(t *testing.T) {
	flat := fakeAgent("fake", true)
	flat.FlatRate, flat.Strengths = true, []string{"easy", "medium"}
	fo := &fakerouter.Options{Route: &fakerouter.RouteScript{Band: "easy"}}
	a := runAuto(t, fo, orchestrator.Options{Agents: []plugins.Agent{flat}}, autoInput, nil)
	if a.status != "completed" || a.child.Model != "acp:fake" || a.child.RouteRequestID == nil {
		t.Fatalf("turn %s child %+v", a.status, a.child)
	}
	seen := waitOutcomes(t, a.fr, 1)
	f := outcomesOf(seen, *a.child.RouteRequestID, "finished")
	if len(f) != 1 || f[0]["status"] != "completed" || f[0]["session_id"] != nil {
		t.Fatalf("finished = %+v", seen)
	}
	if u, _ := f[0]["usage"].(map[string]any); u == nil || u["flat_rate"] == nil {
		t.Fatalf("usage = %+v", f[0]["usage"])
	}
}

func TestRevertingAChangeOfARoutedSubAgentReportsIt(t *testing.T) {
	llm := fakeLLM(func(w http.ResponseWriter, hr *http.Request, req fakeReq) {
		switch {
		case req.isOrchestrator() && len(req.Msgs) == 1:
			respond(w, "tool_use", `{"type":"tool_use","id":"t1","name":"spawn_agent","input":`+fixInput+`}`)
		case req.isOrchestrator():
			respond(w, "end_turn", textBlock("done"))
		case len(req.Msgs) == 1:
			respond(w, "tool_use", `{"type":"tool_use","id":"w1","name":"write_file","input":{"path":"parser.txt","content":"commas\n"}}`)
		default:
			respond(w, "end_turn", textBlock("Done."))
		}
	})
	r, fr := newFakeRig(t, llm, fakerouter.Options{Route: &fakerouter.RouteScript{Choice: "fast"}}, orchestrator.Options{})
	pid := r.project(t, 2)
	if st := r.runCollect(t, pid, "go", nil).status; st != "completed" {
		t.Fatalf("turn = %s", st)
	}
	waitTurn(t, r, pid)
	db, _ := r.store.Get(context.Background(), pid)
	all, err := db.Changes(context.Background(), 0)
	if err != nil || len(all) != 1 {
		t.Fatalf("changes = %+v %v", all, err)
	}
	child, err := db.Agent(context.Background(), all[0].AgentID)
	if err != nil || child.RouteRequestID == nil {
		t.Fatalf("the change is not a routed sub-agent's: %+v %v", child, err)
	}
	if _, err := r.svc.RevertChange(context.Background(), pid, all[0].ID); err != nil {
		t.Fatal(err)
	}
	seen := waitOutcomes(t, fr, 2)
	if got := outcomesOf(seen, *child.RouteRequestID, "reverted"); len(got) != 1 {
		t.Fatalf("reverted = %+v", seen)
	}
}

func TestARewindReportsTheDelegationsItHides(t *testing.T) {
	d := runDelegation(t, fakerouter.RouteScript{Choice: "fast"}, orchestrator.Options{},
		func(string) string { return "Done." }, fixInput)
	waitTurn(t, d.r, d.pid)
	waitOutcomes(t, d.fr, 1)
	db, _ := d.r.store.Get(context.Background(), d.pid)
	orch, _ := db.Orchestrator(context.Background())
	var reqID int64
	for _, m := range d.r.transcript(t, d.pid, orch.ID) {
		if m.Role == "user" && len(m.Content) > 0 && m.Content[0].Text != nil && *m.Content[0].Text == "go" {
			reqID = m.ID
		}
	}
	if _, err := d.r.svc.Rewind(context.Background(), d.pid, reqID, false); err != nil {
		t.Fatal(err)
	}
	seen := waitOutcomes(t, d.fr, 2)
	if got := outcomesOf(seen, *d.kids[0].RouteRequestID, "rewound"); len(got) != 1 {
		t.Fatalf("rewound = %+v", seen)
	}
}
