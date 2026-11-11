package orchestrator_test

import (
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakerouter"
	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
)

// With a router in the path, every agent carries the served model and router
// tier of its newest usage row, in the JSON list and in the agent.updated event
// that the usage row caused.
func TestAgentServedModelAndRoutedTier(t *testing.T) {
	r, _ := newFakeRig(t, mockllm.New(0), fakerouter.Options{}, orchestrator.Options{})
	pid := r.project(t, 1)
	c := r.runCollect(t, pid, "build it", nil)
	if c.status != "completed" {
		t.Fatalf("turn status = %s", c.status)
	}

	// newest main-thread usage row per agent
	type served struct{ model, tier string }
	want := map[string]served{}
	for _, e := range r.usageLog(t, pid) {
		if e.Role == "" {
			want[e.AgentID] = served{e.ServedModel, e.Tier}
		}
	}
	if len(want) == 0 {
		t.Fatal("no usage rows")
	}
	for id, w := range want {
		if w.model == "" || w.tier == "" {
			t.Fatalf("fake router row for %s has no served model/tier: %+v", id, w)
		}
	}

	// the last agent.updated event of each agent carries the same values
	last := map[string]map[string]any{}
	for _, e := range c.of(events.AgentUpdated) {
		a := e["agent"].(map[string]any)
		last[a["id"].(string)] = a
	}
	api := r.api(t)
	_, list := api.do("GET", "/v1/projects/"+pid+"/agents", nil)
	for _, raw := range list["agents"].([]any) {
		a := raw.(map[string]any)
		id := a["id"].(string)
		w, hasRows := want[id]
		if !hasRows {
			if a["served_model"] != nil || a["routed_tier"] != nil {
				t.Errorf("agent %s has no usage but reports %v / %v", id, a["served_model"], a["routed_tier"])
			}
			continue
		}
		if a["served_model"] != w.model || a["routed_tier"] != w.tier {
			t.Errorf("GET agents: %s served_model=%v routed_tier=%v, want %+v", id, a["served_model"], a["routed_tier"], w)
		}
		ev, ok := last[id]
		if !ok || ev["served_model"] != w.model || ev["routed_tier"] != w.tier {
			t.Errorf("last agent.updated for %s = %v, want %+v", id, ev, w)
		}
		if a["model"] == w.model {
			t.Errorf("agent %s: requested and served model are both %v; the test needs them to differ", id, w.model)
		}
	}
}

// Without a router the fields are present and null.
func TestAgentServedModelNullWithoutRouter(t *testing.T) {
	r := newRig(t, mockllm.New(0))
	pid := r.project(t, 1)
	c := r.runCollect(t, pid, "build it", nil)
	if c.status != "completed" {
		t.Fatalf("turn status = %s", c.status)
	}
	for _, e := range c.of(events.AgentUpdated) {
		a := e["agent"].(map[string]any)
		if v, present := a["served_model"]; !present || v != nil {
			t.Fatalf("served_model = %v (present %v), want null", v, present)
		}
		if v, present := a["routed_tier"]; !present || v != nil {
			t.Fatalf("routed_tier = %v (present %v), want null", v, present)
		}
	}
	_, list := r.api(t).do("GET", "/v1/projects/"+pid+"/agents", nil)
	for _, raw := range list["agents"].([]any) {
		a := raw.(map[string]any)
		if a["served_model"] != nil || a["routed_tier"] != nil {
			t.Fatalf("agent %v reports a served model without a router", a)
		}
	}
}
