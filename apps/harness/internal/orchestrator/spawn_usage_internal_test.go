package orchestrator

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
)

// The MCP server's instructions describe spawn_agent's required arguments from
// its schema, with the tier enum and an example, and name the optional ones.
func TestMCPInstructionsDescribeRequiredArguments(t *testing.T) {
	agents := []plugins.Agent{{ID: "claude-code", Label: "Claude Code"}, {ID: "copilot", Label: "Copilot"}}
	plain, err := spawnSchemaFor(agents, false)
	if err != nil {
		t.Fatal(err)
	}
	note := json.RawMessage(`{"type":"object","properties":{"title":{"type":"string","description":"Note title"},` +
		`"content":{"type":"string"}},"required":["title"]}`)
	text := mcpInstructions([]tools.Def{
		{Name: "list_dir", InputSchema: json.RawMessage(`{"type":"object","properties":{"path":{"type":"string"}}}`)},
		{Name: "save_note", InputSchema: note},
		{Name: ToolSpawnAgent, InputSchema: plain},
	})
	lines := strings.Split(text, "\n")
	var spawn string
	for _, l := range lines {
		if strings.HasPrefix(l, "- spawn_agent: ") {
			spawn = l
		}
	}
	for _, want := range []string{
		"requires role (string: Specialist role of the sub-agent, e.g. Code explorer), title (string: ",
		"task (string: Self-contained brief",
		"tier (one of fast, balanced, deep: Model tier by task difficulty)",
		"; optional: agent (claude-code|copilot), env, model.",
		"Example arguments: " + spawnExample,
	} {
		if !strings.Contains(spawn, want) {
			t.Errorf("spawn_agent line lacks %q:\n%s", want, spawn)
		}
	}
	if !strings.Contains(text, "- list_dir: no required arguments; optional: path.") ||
		!strings.Contains(text, "- save_note: requires title (string: Note title); optional: content.") {
		t.Errorf("instructions:\n%s", text)
	}
	if strings.Contains(text, "```") {
		t.Errorf("instructions hold a Markdown fence:\n%s", text)
	}

	// With a router tier is optional and auto is listed.
	routed, err := spawnSchemaFor(nil, true)
	if err != nil {
		t.Fatal(err)
	}
	text = mcpInstructions([]tools.Def{{Name: ToolSpawnAgent, InputSchema: routed}})
	if !strings.Contains(text, "; optional: tier (auto|fast|balanced|deep).") || strings.Contains(text, "tier (one of") {
		t.Errorf("routed instructions:\n%s", text)
	}
}

func TestUnfence(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"```\nspawn_agent requires role\n\nmore\n```", "spawn_agent requires role\n\nmore"},
		{"```console\n6 main.go\n```", "6 main.go"},
		{"```\n1\t# demo\n2\tx\n```\n", "1\t# demo\n2\tx"},
		{"```\n```", ""},
		{"plain text", "plain text"},
		{"```\nopen fence only", "```\nopen fence only"},
		{"```go\na\n```\ntext after\n```\nb\n```", "```go\na\n```\ntext after\n```\nb\n```"},
		{"```\nx```", "```\nx```"},
		{"````\nquad\n````", "````\nquad\n````"},
		{"intro\n```\ncode\n```", "intro\n```\ncode\n```"},
	} {
		if got := unfence(tc.in); got != tc.want {
			t.Errorf("unfence(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
