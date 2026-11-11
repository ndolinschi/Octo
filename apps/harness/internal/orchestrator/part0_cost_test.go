package orchestrator_test

import (
	"context"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakeacp"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakerouter"
	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
)

func costOf(t *testing.T, r *rig, pid string) (sum float64, flat, nonFlat int) {
	t.Helper()
	for _, e := range r.usageLog(t, pid) {
		if e.Source != "acp" || e.CostUSD == nil {
			continue
		}
		sum += *e.CostUSD
		if e.FlatRate {
			flat++
			if !e.CostEstimated {
				t.Errorf("a flat-rate row is not marked estimated: %+v", e)
			}
		} else {
			nonFlat++
		}
	}
	return
}

func TestFlatRateAgentCostIsNotSpend(t *testing.T) {
	ag := fakeAgent("fake", true)
	ag.FlatRate = true
	r := newACPRig(t, mockllm.New(0), ag)
	dir := t.TempDir()
	pid := r.projectAt(t, dir)
	r.update(t, pid, budgetInput(0.01))
	got := r.runCollect(t, pid, "[acp] summarize", nil)
	if got.status != "completed" {
		t.Fatalf("turn = %s", got.status)
	}
	sum, flat, nonFlat := costOf(t, r, pid)
	if flat != 2 || nonFlat != 0 || !near(sum, 0.03) {
		t.Fatalf("rows: flat=%d non-flat=%d sum=%v (the two cumulative updates 0.012 and 0.03 make 0.03)", flat, nonFlat, sum)
	}
	p, err := r.svc.Get(context.Background(), pid)
	if err != nil {
		t.Fatal(err)
	}
	if p.SpentUSD != nil {
		t.Fatalf("spent_usd = %v, want unknown: a subscription estimate is not spend", *p.SpentUSD)
	}
	rep, err := r.svc.Usage(context.Background(), project.UsageQuery{ProjectID: pid, Group: "project"})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Total.CostUSD != nil || rep.Total.SubscriptionEquivalentUSD == nil || !near(*rep.Total.SubscriptionEquivalentUSD, 0.03) {
		t.Fatalf("total = %+v", rep.Total)
	}
	// Over a $0.01 budget by the estimate, yet the next request is not stopped.
	if got := r.runCollect(t, pid, "[acp] again", nil); got.status != "completed" {
		t.Fatalf("second turn = %s", got.status)
	}
}

func TestNonFlatAgentCostStaysSpend(t *testing.T) {
	r := newACPRig(t, mockllm.New(0), fakeAgent("fake", true))
	pid := r.projectAt(t, t.TempDir())
	r.runCollect(t, pid, "[acp] summarize", nil)
	sum, flat, nonFlat := costOf(t, r, pid)
	if flat != 0 || nonFlat != 2 || !near(sum, 0.03) {
		t.Fatalf("flat=%d non-flat=%d sum=%v", flat, nonFlat, sum)
	}
	p, _ := r.svc.Get(context.Background(), pid)
	if p.SpentUSD == nil || !near(*p.SpentUSD, 0.03) {
		t.Fatalf("spent = %v", p.SpentUSD)
	}
}

// The agent's session-wide counters outlive a turn: a second turn's first update
// is a delta, not the whole session again.
func TestACPOrchestratorCumulativeUsageIsNotCountedTwice(t *testing.T) {
	r := newACPRig(t, mockllm.New(0), fakeAgent("fake", true))
	pid := r.supervisedProject(t, t.TempDir(), "acp:fake")
	name := "full"
	if _, err := r.svcWithAgents(t, fakeAgent("fake", true)).Update(context.Background(), pid, project.Input{Access: &name}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		r.runCollect(t, pid, "[cum-cost] count", nil)
		for r.orch.Running(pid) { // the slot is released just after turn.finished
			time.Sleep(time.Millisecond)
		}
	}
	sum, _, _ := costOf(t, r, pid)
	if !near(sum, 0.03) {
		t.Fatalf("summed cost over three turns = %v, want 0.03 (0.01 per turn)", sum)
	}
	var used int64
	for _, e := range r.usageLog(t, pid) {
		used += e.InputTokens
	}
	if used != 1300 {
		t.Fatalf("input tokens = %d, want 1300 (1100 + 100 + 100)", used)
	}
}

// One budget, one number: with a router the router's spend decides, a
// subscription agent's estimate never does, and the orchestrator's own requests
// stop on the same condition as delegation.
func TestRouterSpendIsTheOnlyBudgetNumber(t *testing.T) {
	ag := fakeAgent("fake", true)
	ag.FlatRate = true
	cheap := map[string][2]float64{"low": {1, 1}, "mid": {1, 1}, "high": {1, 1}}
	r, fr := newFakeRig(t, mockllm.New(0), fakerouter.Options{Rates: cheap, IgnoreBudget: true}, orchestrator.Options{Agents: []plugins.Agent{ag}})
	pid := r.project(t, 1)
	r.update(t, pid, budgetInput(0.01))

	// A flat-rate agent's $0.03 estimate is over the $0.01 budget; the router's spend is below it.
	if st := r.run(t, pid, "[acp] summarize", nil); st != "completed" {
		t.Fatalf("turn with a flat-rate agent = %s, want completed", st)
	}
	if _, flat, _ := costOf(t, r, pid); flat == 0 {
		t.Fatal("the flat-rate agent recorded no estimate")
	}
	p, err := r.svc.Get(context.Background(), pid)
	if err != nil || p.SpentUSD == nil || *p.SpentUSD >= 0.01 {
		t.Fatalf("spent_usd = %v (%v): the estimate must not count", p.SpentUSD, err)
	}
	if st := r.run(t, pid, "[acp] once more", nil); st != "completed" {
		t.Fatalf("second turn = %s", st)
	}

	// Now the router says the budget is spent. The first request learns it from the
	// response; delegation is refused at once and the orchestrator's next request is
	// not sent: the same condition, one number.
	fr.SetSpent(pid, 0.02)
	agentsBefore, callsBefore := len(r.agents(t, pid)), fr.UpstreamCalls()
	if st := r.run(t, pid, "[acp] third", nil); st != "failed" {
		t.Fatalf("turn over the router's budget = %s, want failed", st)
	}
	for _, a := range r.agents(t, pid)[agentsBefore:] {
		if a.Status != "failed" || a.Error == nil || !strings.Contains(*a.Error, "Project budget reached") {
			t.Fatalf("a sub-agent was started over budget: %s %v", a.Status, a.Error)
		}
	}
	refused := false
	for _, m := range toolResultTexts(t, r, pid, r.agents(t, pid)[0].ID) {
		refused = refused || strings.Contains(m, "Project budget reached ($0.02 of $0.01)")
	}
	if !refused {
		t.Fatal("delegation was not refused with the budget message")
	}
	if n := fr.UpstreamCalls() - callsBefore; n != 1 {
		t.Fatalf("upstream calls this turn = %d, want 1: the next orchestrator request must be stopped by the same check", n)
	}
	e := r.agents(t, pid)[0].Error
	if e == nil || !regexp.MustCompile(`^Project budget reached \(\$0\.02 of \$0\.01\)$`).MatchString(*e) {
		t.Fatalf("orchestrator error = %v", e)
	}
	for _, q := range fr.Requests() {
		if q.Header.Get("x-octo-budget-usd") != "0.01" {
			t.Fatalf("a request went out without the budget header: %v", q.Header)
		}
	}
}

// turn.finished is published after the turn's slot is released: a client that
// reacts to it at once never meets "turn already in progress". (Before, the slot
// was released just after the event, which made tests that kill an agent and send
// the next request straight away fail now and then, e.g.
// TestACPOrchestratorRecoversWithLoadSession.)
func TestTurnFinishedComesAfterTheSlotIsReleased(t *testing.T) {
	r := newRig(t, mockllm.New(0))
	pid := r.project(t, 1)
	for i := 0; i < 40; i++ {
		ch, cancel := r.hub.Subscribe(pid)
		if _, err := r.orch.Start(context.Background(), pid, "quick hello"); err != nil {
			t.Fatalf("round %d: Start right after turn.finished: %v", i, err)
		}
		for ev := range ch {
			if ev.Type == "turn.finished" {
				if r.orch.Running(pid) {
					t.Fatalf("round %d: the turn still holds its slot when turn.finished arrives", i)
				}
				break
			}
		}
		cancel()
	}
}

// A delegation refused for budget reasons is announced: agent.created, then
// agent.updated with status failed and the reason.
func TestBudgetRefusedDelegationAnnouncesFailedAgent(t *testing.T) {
	r, fr := newFakeRig(t, mockllm.New(0), fakerouter.Options{IgnoreBudget: true}, orchestrator.Options{})
	pid := r.project(t, 1)
	r.update(t, pid, budgetInput(0.01))
	// The router's figure is learned from the first response; the spawns that follow are refused.
	fr.SetSpent(pid, 0.02)
	got := r.runCollect(t, pid, "build it", nil)
	if got.status != "failed" {
		t.Fatalf("turn = %s", got.status)
	}
	created := map[string]bool{}
	for _, m := range got.of("agent.created") {
		created[m["agent"].(map[string]any)["id"].(string)] = true
	}
	failed := 0
	for _, m := range got.of("agent.updated") {
		a := m["agent"].(map[string]any)
		if id := a["id"].(string); created[id] && a["status"] == "failed" {
			if e, _ := a["error"].(string); !strings.Contains(e, "Project budget reached") {
				t.Errorf("failed agent error = %q", e)
			}
			failed++
		}
	}
	if len(created) == 0 || failed != len(created) {
		t.Fatalf("created %d refused agents, %d announced failed", len(created), failed)
	}
}

// A process that resumes the session with session/load continues its counters:
// they are seeded from what the session reported before, so the first update
// after the resume is a delta. (The scripted agent restarts its counters at the
// same figure, which then counts as "no change"; without the seed the figure
// would be recorded a second time.)
func TestResumedSessionContinuesTheUsageCounters(t *testing.T) {
	ag := fakeAgent("fake", true)
	ag.Env[fakeacp.EnvLoadSession] = "1"
	ag.Env[fakeacp.EnvUniqueSessions] = "1"
	r := newACPRig(t, mockllm.New(0), ag)
	pid := r.projectAt(t, t.TempDir())
	name := "acp:fake"
	if _, err := r.svcWithAgents(t, ag).Update(context.Background(), pid, project.Input{Models: &config.Models{Orchestrator: name}}); err != nil {
		t.Fatal(err)
	}
	r.runCollect(t, pid, "[cum-cost] one", nil)
	for r.orch.Running(pid) {
		time.Sleep(time.Millisecond)
	}
	r.orch.CloseProject(pid) // ends the agent process; the stored session id stays
	r.runCollect(t, pid, "[cum-cost] two", nil)
	sum, _, _ := costOf(t, r, pid)
	if !near(sum, 0.01) {
		t.Fatalf("summed cost = %v, want 0.01 (the resumed session's counter did not move)", sum)
	}
}
