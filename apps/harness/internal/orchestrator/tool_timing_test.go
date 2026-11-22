package orchestrator_test

import (
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
)

// toolTimings checks the run card's data on a finished turn: every tool.started says when, every tool.finished how long,
// and every stored tool result of the given agents carries the same duration (once, after a reload from the database).
func toolTimings(t *testing.T, r *rig, pid string, evs []stamped) map[string]int64 {
	t.Helper()
	started := ofType(evs, events.ToolStarted)
	finished := ofType(evs, events.ToolFinished)
	if len(started) == 0 || len(finished) == 0 {
		t.Fatalf("no tool events: %d started, %d finished", len(started), len(finished))
	}
	for _, e := range started {
		at, ok := e.data["started_at"].(string)
		if !ok {
			t.Fatalf("tool.started without started_at: %v", e.data)
		}
		if _, err := time.Parse(time.RFC3339Nano, at); err != nil {
			t.Fatalf("started_at %q: %v", at, err)
		}
	}
	live := map[string]int64{}
	agents := map[string]bool{}
	for _, e := range finished {
		ms, ok := e.data["duration_ms"].(float64)
		if !ok || ms < 0 {
			t.Fatalf("tool.finished without duration_ms: %v", e.data)
		}
		live[e.data["agent_id"].(string)+"/"+e.data["tool_use_id"].(string)] = int64(ms)
		agents[e.data["agent_id"].(string)] = true
	}
	stored := map[string]int64{}
	for aid := range agents {
		for _, m := range r.transcript(t, pid, aid) {
			for _, b := range m.Content {
				if b.Type == "tool_result" && b.ToolUseID != nil && b.DurationMs != nil {
					stored[aid+"/"+*b.ToolUseID] = *b.DurationMs
				}
			}
		}
	}
	for id, ms := range live {
		got, ok := stored[id]
		if !ok {
			t.Fatalf("stored result of %s has no duration (live %d ms)", id, ms)
		}
		if got != ms {
			t.Fatalf("stored duration of %s = %d, live %d", id, got, ms)
		}
	}
	return stored
}

func TestToolTimingsBuiltinLoop(t *testing.T) {
	r := newRigWith(t, mockllm.New(0), orchestrator.Options{Stream: true})
	pid := r.projectAt(t, t.TempDir())
	evs, status := r.liveRun(t, pid, "build it [write:notes/{role}.md]")
	if status != "completed" {
		t.Fatalf("status = %s", status)
	}
	toolTimings(t, r, pid, evs)
}

func TestToolTimingsACPStoresBeforeFinishing(t *testing.T) {
	r := liveRigWith(t, 0)
	pid := r.acpOrchProject(t)
	evs, status := r.liveRun(t, pid, "[slow-tool] go")
	if status != "completed" {
		t.Fatalf("status = %s", status)
	}
	stored := toolTimings(t, r, pid, evs)
	slow := false
	for _, ms := range stored {
		slow = slow || ms >= 200 // the scripted agent holds the call 400 ms
	}
	if !slow {
		t.Fatalf("durations %v, want one of ~400 ms", stored)
	}
}
