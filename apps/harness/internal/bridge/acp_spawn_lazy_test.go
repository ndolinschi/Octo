package bridge_test

import (
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/fakeacp"
)

// An ACP orchestrator that calls spawn_agent before loading the tool's schema
// (Claude Code's MCP tool search). The owner's live run: the first call
// carried only task and tier and was refused, the retry worked.

// With the MCP server's instructions the first call is already right.
func TestACPLazySchemaFirstSpawnSucceedsFromInstructions(t *testing.T) {
	e := newACPEnv(t, map[string]string{fakeacp.EnvMCPHTTP: "1"}, nil)
	p := e.acpProject(t)

	tr := e.ask(t, p, "[echo] hello")
	if tr.status != "completed" {
		t.Fatalf("turn = %s, %v", tr.status, tr.errMsg)
	}
	if text := e.lastText(t, p); !strings.Contains(text, "spawn_agent takes role (a specialist role") ||
		!strings.Contains(text, "and tier, all four required. Example arguments: {") {
		t.Errorf("the briefing does not name spawn_agent's arguments:\n%s", text)
	}

	tr = e.ask(t, p, "[mcp-spawn-lazy] go")
	if tr.status != "completed" || tr.errMsg != nil {
		t.Fatalf("turn = %s, error %v", tr.status, tr.errMsg)
	}
	if text := e.lastText(t, p); !strings.Contains(text, "lazy-spawn first=ok retry=none report=") {
		t.Fatalf("final text = %q", text)
	}
	kids := 0
	for _, a := range e.agents(t, p) {
		if a.ParentID != nil {
			kids++
			if a.Title != "Look around" || a.Status != "completed" {
				t.Errorf("sub-agent = %+v", a)
			}
		}
	}
	if kids != 1 {
		t.Errorf("%d sub-agents, want 1", kids)
	}
}

// Without them (a guess from the briefing alone) the refusal states what is
// missing with an example, so the one retry is right, and the stored result is
// plain text although the agent fenced it.
func TestACPLazySchemaRefusalGuidesTheRetry(t *testing.T) {
	e := newACPEnv(t, map[string]string{fakeacp.EnvMCPHTTP: "1"}, nil)
	p := e.acpProject(t)
	tr := e.ask(t, p, "[mcp-spawn-guess] go")
	if tr.status != "completed" || tr.errMsg != nil {
		t.Fatalf("turn = %s, error %v", tr.status, tr.errMsg)
	}
	if text := e.lastText(t, p); !strings.Contains(text, "lazy-spawn first=refused retry=ok report=") {
		t.Fatalf("final text = %q", text)
	}
	var refusal string
	for _, m := range e.messages(t, p, p.OrchestratorAgentID) {
		for _, c := range m.Content {
			if c.Type == "tool_result" && c.ToolUseID == "mcp-lazy-1" {
				refusal = c.Content
			}
		}
	}
	if !strings.HasPrefix(refusal, "spawn_agent requires role, title, task and tier (fast|balanced|deep). Missing: role, title.") ||
		strings.Contains(refusal, "```") {
		t.Errorf("stored refusal = %q, want the harness's plain text without the agent's fence", refusal)
	}
}
