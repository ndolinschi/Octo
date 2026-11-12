package bridge_test

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// requestID is the id of the orchestrator's user message whose text contains s.
func (e *env) requestID(t *testing.T, pid, s string) int64 {
	t.Helper()
	var p project.Project
	e.into(t, "GET", "/v1/projects/"+pid, nil, http.StatusOK, &p)
	var msgs struct{ Messages []projectstore.Message }
	e.into(t, "GET", "/v1/projects/"+pid+"/agents/"+p.OrchestratorAgentID+"/messages", nil, http.StatusOK, &msgs)
	for _, m := range msgs.Messages {
		if m.Role == "user" && len(m.Content) > 0 && m.Content[0].Text != nil && strings.Contains(*m.Content[0].Text, s) {
			return m.ID
		}
	}
	t.Fatalf("no request containing %q", s)
	return 0
}

func (e *env) orchestratorMessages(t *testing.T, pid string) int {
	t.Helper()
	var p project.Project
	e.into(t, "GET", "/v1/projects/"+pid, nil, http.StatusOK, &p)
	var msgs struct{ Messages []projectstore.Message }
	e.into(t, "GET", "/v1/projects/"+pid+"/agents/"+p.OrchestratorAgentID+"/messages", nil, http.StatusOK, &msgs)
	return len(msgs.Messages)
}

func exists(dir, name string) bool {
	_, err := os.Stat(filepath.Join(dir, name))
	return err == nil
}

func TestRewindRestoresFilesAndCutsTheConversation(t *testing.T) {
	e := newEnv(t, nil)
	pid, dir := e.v7Project(t, "full")
	e.runTurn(t, pid, "First [write:{role}.md]")
	e.runTurn(t, pid, "Second [rewrite:{role}.txt]")
	e.runTurn(t, pid, "Third [bash:echo hi > made.txt && rm README.md]")
	first, second := e.requestID(t, pid, "First"), e.requestID(t, pid, "Second")
	before := e.orchestratorMessages(t, pid)

	// A dry run says what would happen and changes nothing.
	var dry orchestrator.RewindReport
	e.into(t, "POST", "/v1/projects/"+pid+"/rewind", map[string]any{"message_id": second, "dry_run": true}, http.StatusOK, &dry)
	if !dry.DryRun || dry.RequestText != "Second [rewrite:{role}.txt]" || len(dry.Conflicts) != 0 || dry.MessagesCut == 0 {
		t.Fatalf("dry run = %+v", dry)
	}
	actions := map[string]string{}
	for _, f := range dry.Files {
		actions[f.Path] = f.Action
	}
	if len(dry.Files) != 5 || actions["made.txt"] != "delete" || actions["README.md"] != "restore" {
		t.Fatalf("dry run files = %+v", dry.Files)
	}
	// Newest change first: the third turn's files come before the second turn's.
	if dry.Files[0].Path != "made.txt" && dry.Files[0].Path != "README.md" {
		t.Fatalf("restore order: %+v", dry.Files)
	}
	if e.orchestratorMessages(t, pid) != before || !exists(dir, "made.txt") || exists(dir, "README.md") {
		t.Fatal("a dry run changed something")
	}

	// The real thing.
	var rep orchestrator.RewindReport
	e.into(t, "POST", "/v1/projects/"+pid+"/rewind", map[string]any{"message_id": second}, http.StatusOK, &rep)
	if rep.DryRun || rep.RequestText != "Second [rewrite:{role}.txt]" || len(rep.Files) != 5 || rep.MessagesCut == 0 || rep.ACPSessionReset {
		t.Fatalf("rewind = %+v", rep)
	}
	if exists(dir, "made.txt") || !exists(dir, "README.md") {
		t.Fatal("the third turn's files were not restored")
	}
	if m, _ := filepath.Glob(filepath.Join(dir, "*.txt")); len(m) != 0 {
		t.Fatalf("the second turn's files are still there: %v", m)
	}
	if m, _ := filepath.Glob(filepath.Join(dir, "*.md")); len(m) < 3 {
		t.Fatalf("the first turn's files were touched: %v", m)
	}
	if got := e.orchestratorMessages(t, pid); got >= before || got == 0 {
		t.Fatalf("messages %d -> %d", before, got)
	}
	// Soft: the conversation up to the first request is intact, later ones are gone, and nothing of the cut turns is searchable.
	e.requestID(t, pid, "First")
	var turns turnsResp
	e.into(t, "GET", "/v1/projects/"+pid+"/changes", nil, http.StatusOK, &turns)
	if len(turns.Turns) != 1 {
		t.Fatalf("changes of the cut turns survive: %+v", turns.Turns)
	}
	var agents struct{ Agents []projectstore.Agent }
	e.into(t, "GET", "/v1/projects/"+pid+"/agents", nil, http.StatusOK, &agents)
	if len(agents.Agents) != 5 { // the orchestrator and the first turn's four sub-agents
		t.Fatalf("agents after the rewind: %d", len(agents.Agents))
	}
	// The cut request is gone: a second rewind to it is refused, and the first can still be rewound to.
	e.wantError(t, "POST", "/v1/projects/"+pid+"/rewind", map[string]any{"message_id": second}, http.StatusBadRequest, "invalid_request")
	e.wantError(t, "POST", "/v1/projects/"+pid+"/rewind", map[string]any{"message_id": 999999}, http.StatusBadRequest, "invalid_request")
	e.wantError(t, "POST", "/v1/projects/prj_nope/rewind", map[string]any{"message_id": 1}, http.StatusNotFound, "not_found")
	e.into(t, "POST", "/v1/projects/"+pid+"/rewind", map[string]any{"message_id": first}, http.StatusOK, nil)
	if m, _ := filepath.Glob(filepath.Join(dir, "*-*.md")); len(m) != 0 {
		t.Fatalf("rewinding to the first request left its files: %v", m)
	}
}

func TestRewindRefusesWhenAFileChangedOutsideTheHarness(t *testing.T) {
	e := newEnv(t, nil)
	pid, dir := e.v7Project(t, "full")
	e.runTurn(t, pid, "One [bash:echo made > made.txt]")
	e.runTurn(t, pid, "Two [bash:echo more >> made.txt]")
	one := e.requestID(t, pid, "One")
	before := e.orchestratorMessages(t, pid)
	if err := os.WriteFile(filepath.Join(dir, "made.txt"), []byte("edited by hand\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	status, body := e.do(t, "POST", "/v1/projects/"+pid+"/rewind", map[string]any{"message_id": one})
	if status != http.StatusConflict || !strings.Contains(string(body), `"rewind_conflict"`) || !strings.Contains(string(body), `"made.txt"`) ||
		!strings.Contains(string(body), `"modified_outside"`) {
		t.Fatalf("rewind = %d %s", status, body)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "made.txt")); string(got) != "edited by hand\n" || e.orchestratorMessages(t, pid) != before {
		t.Fatal("a refused rewind changed something")
	}
	// A dry run reports the conflict as data (200).
	var dry orchestrator.RewindReport
	e.into(t, "POST", "/v1/projects/"+pid+"/rewind", map[string]any{"message_id": one, "dry_run": true}, http.StatusOK, &dry)
	if len(dry.Conflicts) != 1 || dry.Conflicts[0].Path != "made.txt" || dry.Conflicts[0].Reason != "modified_outside" {
		t.Fatalf("dry run = %+v", dry)
	}
}

func TestRewindRefusedWhileATurnRuns(t *testing.T) {
	gate := make(chan struct{})
	e := newEnv(t, gate)
	pid, _ := e.v7Project(t, "full")
	close(gate)
	e.runTurn(t, pid, "quick one")
	one := e.requestID(t, pid, "quick one")
	e.into(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": "Go [bash:sleep 2]"}, http.StatusAccepted, nil)
	e.wantError(t, "POST", "/v1/projects/"+pid+"/rewind", map[string]any{"message_id": one}, http.StatusConflict, "turn_in_progress")
	e.into(t, "POST", "/v1/projects/"+pid+"/cancel", nil, http.StatusAccepted, nil)
	e.waitIdle(t, pid)
}
