package orchestrator

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
)

// ACPModelPrefix prefixes the model recorded for an ACP sub-agent.
const ACPModelPrefix = "acp:"

// acpAgents returns the available ACP agents, in plugin load order.
func (rt *runtime) acpAgents() []plugins.Agent {
	var out []plugins.Agent
	for _, a := range rt.o.opts.Agents {
		if a.Available {
			out = append(out, a)
		}
	}
	return out
}

// pickACPAgent resolves a spawn_agent `agent` value; a non-empty message is
// the error result for the model.
func (rt *runtime) pickACPAgent(id string) (plugins.Agent, string) {
	for _, a := range rt.acpAgents() {
		if a.ID == id {
			if len(rt.folders) == 0 {
				return a, "ACP agents work inside a project folder, and this project has none attached"
			}
			return a, ""
		}
	}
	return plugins.Agent{}, fmt.Sprintf("unknown or unavailable ACP agent %q", id)
}

// spawnSchema is the spawn_agent input schema; `agent` appears only when
// at least one ACP agent is available.
func spawnSchema(agents []plugins.Agent) (json.RawMessage, error) {
	props := map[string]any{
		"role":  map[string]any{"type": "string", "description": "Specialist role, e.g. Code explorer"},
		"title": map[string]any{"type": "string", "description": "Short task title"},
		"task":  map[string]any{"type": "string", "description": "Self-contained brief including the expected report format"},
		"tier": map[string]any{
			"type": "string", "enum": []string{"fast", "balanced", "deep"}, "description": "Model tier by task difficulty",
		},
	}
	if len(agents) > 0 {
		ids := make([]string, len(agents))
		for i, a := range agents {
			ids[i] = a.ID
		}
		props["agent"] = map[string]any{
			"type": "string", "enum": ids,
			"description": "Optional. Run the task on an external local coding agent (a separate harness on the user's machine, " +
				"with its own tools and model) instead of a built-in sub-agent. Use it when the user asks for one by name or when " +
				"another harness suits a self-contained coding task. Available: " + agentList(agents) + ". Omit for a normal sub-agent.",
		}
	}
	return json.Marshal(map[string]any{
		"type": "object", "properties": props, "required": []string{"role", "title", "task", "tier"},
	})
}

func agentList(agents []plugins.Agent) string {
	parts := make([]string, len(agents))
	for i, a := range agents {
		parts[i] = fmt.Sprintf("%s (%s)", a.ID, a.Label)
	}
	return strings.Join(parts, ", ")
}

func (rt *runtime) acpPrompt() string {
	agents := rt.acpAgents()
	if len(agents) == 0 || len(rt.folders) == 0 {
		return ""
	}
	return "\nExternal agents: spawn_agent also accepts an `agent` id for delegating a self-contained coding task to an " +
		"external local agent, a separate coding harness on the user's machine with its own tools and model. Available: " +
		agentList(agents) + ". Brief it like any sub-agent; omit `agent` for built-in sub-agents.\n"
}
