package bridge_test

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/acptrace"
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

// R1.5: with the trace on, an ACP session leaves a per-session file under the
// data dir; the MCP bearer token the harness handed to the agent is not in it.
func TestACPTraceFileHasNoBearerToken(t *testing.T) {
	dir := t.TempDir()
	acptrace.Configure(dir, true)
	t.Cleanup(func() { acptrace.Configure(t.TempDir(), false) })
	e := newACPEnv(t, map[string]string{fakeacp.EnvMCPHTTP: "1"}, nil)
	p := e.acpProject(t)
	tr := e.ask(t, p, fakeacp.MarkerMCPInfo+" go")
	if tr.status != "completed" {
		t.Fatalf("turn = %s %v", tr.status, tr.errMsg)
	}
	text := e.lastText(t, p)
	i := strings.Index(text, "token=")
	if i < 0 {
		t.Fatalf("the agent did not report its token: %q", text)
	}
	token := strings.Fields(text[i+len("token="):])[0]
	if len(token) < 8 {
		t.Fatalf("token = %q", token)
	}
	files := acptrace.Files()
	if len(files) != 1 {
		t.Fatalf("trace files = %v", files)
	}
	data, err := os.ReadFile(files[0])
	if err != nil {
		t.Fatal(err)
	}
	got := string(data)
	if strings.Contains(got, token) {
		t.Fatalf("the trace contains the MCP bearer token:\n%s", got)
	}
	for _, want := range []string{"client->agent", "agent->client", `"method":"initialize"`, `"method":"session/new"`, "[redacted]", "octo-harness"} {
		if !strings.Contains(got, want) {
			t.Errorf("trace lacks %q", want)
		}
	}
	if filepath.Dir(files[0]) != filepath.Join(dir, "traces") {
		t.Fatalf("trace outside the data dir: %s", files[0])
	}
}
