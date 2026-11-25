package bridge_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/bridge"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
)

type fakeWorkers struct{ list []orchestrator.WorkerProcess }

func (f fakeWorkers) WorkerProcesses(string) []orchestrator.WorkerProcess { return f.list }
func (f fakeWorkers) StopWorkerProcess(string, string) bool               { return false }

// G3: an agent worker names the session it serves, so the Processes tab can say who started it.
func TestProcessesAgentWorkerCarriesSessionID(t *testing.T) {
	workers := fakeWorkers{list: []orchestrator.WorkerProcess{{
		ID: "acp:s1", SessionID: "s1", Name: "claude-code", Model: "opus", Command: "claude --acp", PID: 4242, StartedAt: time.Now(),
	}}}
	e := newEnvWith(t, nil, nil, bridge.WithWorkerProcesses(workers))
	var p project.Project
	e.into(t, "POST", "/v1/projects", map[string]any{
		"name":    "Workers",
		"folders": []map[string]string{{"label": "app", "path": t.TempDir()}},
	}, http.StatusCreated, &p)

	var out struct {
		Processes []struct {
			ID        string `json:"id"`
			Kind      string `json:"kind"`
			SessionID string `json:"session_id"`
		} `json:"processes"`
	}
	e.into(t, "GET", "/v1/projects/"+p.ID+"/processes", nil, http.StatusOK, &out)
	if len(out.Processes) != 1 {
		t.Fatalf("want one process, got %+v", out.Processes)
	}
	got := out.Processes[0]
	if got.ID != "acp:s1" || got.Kind != "agent" || got.SessionID != "s1" {
		t.Fatalf("agent worker = %+v, want id acp:s1, kind agent, session_id s1", got)
	}
}
