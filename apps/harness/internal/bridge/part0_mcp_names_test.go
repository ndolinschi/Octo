package bridge_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"syscall"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/fakeacp"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// An ACP orchestrator's calls to the harness's own tools are stored as the
// built-in loop stores them (the tool's name, its arguments), whatever title
// the agent announced them under, and the sub-agent links to that row.
func TestACPOrchestratorHarnessCallsKeepTheToolName(t *testing.T) {
	for _, tc := range []struct{ name, title string }{
		{"mcp double underscore", "mcp__octo-harness__%s"},
		{"colon", "octo-harness:%s"},
		{"colon space", "octo-harness: %s"},
		{"double underscore", "octo-harness__%s"},
		{"title names the tool, input fits the schema", "Calling %s now"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newACPEnv(t, map[string]string{fakeacp.EnvMCPTitle: tc.title}, nil)
			p := e.acpProject(t)
			tr := e.ask(t, p, fakeacp.MarkerMCPSpawnBuiltin+" delegate")
			if tr.status != "completed" {
				t.Fatalf("turn = %s %v", tr.status, tr.errMsg)
			}
			var spawnUse, noteUse string
			for _, m := range e.messages(t, p, p.OrchestratorAgentID) {
				for _, c := range m.Content {
					if c.Type != "tool_use" {
						continue
					}
					if strings.Contains(c.Name, "mcp") || strings.Contains(string(c.Input), "mcp__") {
						t.Errorf("raw MCP name leaked into the transcript: %q %s", c.Name, c.Input)
					}
					var in map[string]any
					_ = json.Unmarshal(c.Input, &in)
					switch c.Name {
					case "spawn_agent":
						spawnUse = c.ID
						if in["title"] != "Look around" || in["task"] != "Report that you are ready." || in["tier"] == nil {
							t.Errorf("spawn_agent input = %s", c.Input)
						}
					case "save_note":
						noteUse = c.ID
						if in["title"] != "mcp-note" {
							t.Errorf("save_note input = %s", c.Input)
						}
					}
				}
			}
			if spawnUse == "" || noteUse == "" {
				t.Fatalf("tool_use rows: spawn=%q note=%q", spawnUse, noteUse)
			}
			var agents struct{ Agents []projectstore.Agent }
			e.into(t, "GET", "/v1/projects/"+p.ID+"/agents", nil, http.StatusOK, &agents)
			linked := false
			for _, a := range agents.Agents {
				if a.ParentID != nil && a.SpawnToolUseID != nil && *a.SpawnToolUseID == spawnUse {
					linked = true
				}
			}
			if !linked {
				t.Fatalf("the sub-agent is not linked to the spawn_agent row %s: %+v", spawnUse, agents.Agents)
			}
		})
	}
}

// The agent process dies between two turns and the harness has not seen its
// exit yet when the next request arrives (the exit is noticed asynchronously):
// the request must still be answered, by a restarted agent. This was the cause
// of the occasional failure of TestACPOrchestratorRecoversWithLoadSession: the
// test treats a zombie as gone, the harness had not yet seen EOF, wrote the
// prompt to a dead process and failed the turn.
func TestACPOrchestratorAnswersWhenTheAgentDiedJustBefore(t *testing.T) {
	e := newACPEnv(t, map[string]string{fakeacp.EnvLoadSession: "1"}, nil)
	p := e.acpProject(t)
	e.ask(t, p, "[echo] one")
	first := parseIdentity(t, e.lastText(t, p))
	if err := syscall.Kill(first.pid, syscall.SIGKILL); err != nil { // no wait: the harness has not noticed
		t.Fatal(err)
	}
	tr := e.ask(t, p, "[echo] two")
	if tr.status != "completed" {
		t.Fatalf("status = %s (%v)", tr.status, tr.errMsg)
	}
	if second := parseIdentity(t, e.lastText(t, p)); second.pid == first.pid {
		t.Fatalf("the dead process answered? %+v", second)
	}
}
