package orchestrator

import (
	"encoding/json"
	"fmt"
	"maps"
	"slices"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
)

// ACPModelPrefix prefixes the model recorded for an ACP sub-agent.
const ACPModelPrefix = "acp:"

// acpAgents returns the available ACP agents, in plugin load order.
func (rt *runtime) acpAgents() []plugins.Agent {
	var out []plugins.Agent
	for _, a := range rt.o.agents() {
		if a.Available {
			out = append(out, a)
		}
	}
	return out
}

func (o *Orchestrator) agents() []plugins.Agent {
	if o.opts.AgentSource != nil {
		return o.opts.AgentSource()
	}
	return o.opts.Agents
}

// acpTarget is an ACP agent with the model one delegation will use: the
// requested one, else the manifest default, else none.
type acpTarget struct {
	agent     plugins.Agent
	model     string
	requested bool // the model came from spawn_agent, not the manifest default
	// env is extra environment for the agent's process: secrets spawn_agent's
	// env mapped, already resolved.
	env map[string]string
}

// processEnv is the agent's manifest environment plus the mapped secrets.
func (t acpTarget) processEnv() map[string]string {
	env := t.agent.ResolvedEnv()
	if len(t.env) == 0 {
		return env
	}
	out := make(map[string]string, len(env)+len(t.env))
	maps.Copy(out, env)
	maps.Copy(out, t.env)
	return out
}

// recorded is the model stored on the sub-agent and its usage rows.
func (t acpTarget) recorded() string {
	if t.model == "" {
		return ACPModelPrefix + t.agent.ID
	}
	return ACPModelPrefix + t.agent.ID + "/" + t.model
}

// pickACPAgent resolves a spawn_agent `agent` and `model`; a non-empty message
// is the error result for the model.
func (rt *runtime) pickACPAgent(id, model string) (acpTarget, string) {
	for _, a := range rt.acpAgents() {
		if a.ID != id {
			continue
		}
		if len(rt.folders) == 0 {
			return acpTarget{}, "ACP agents work inside a project folder, and this project has none attached"
		}
		t := acpTarget{agent: a, model: a.DefaultModel}
		if model == "" {
			return t, ""
		}
		switch {
		case !plugins.ModelPattern.MatchString(model):
			return acpTarget{}, fmt.Sprintf("invalid model %q", model)
		case len(a.Models) > 0 && !slices.Contains(a.Models, model):
			return acpTarget{}, fmt.Sprintf("ACP agent %q has no model %q; choose one of: %s", id, model, strings.Join(a.Models, ", "))
		}
		t.model, t.requested = model, true
		return t, ""
	}
	return acpTarget{}, fmt.Sprintf("unknown or unavailable ACP agent %q", id)
}

// modelChoices describes the models of the available agents for the schema:
// the union (an enum only when every agent lists its models) and a sentence.
func modelChoices(agents []plugins.Agent) (enum []string, desc string) {
	allListed := true
	var parts []string
	for _, a := range agents {
		if len(a.Models) == 0 {
			allListed = false
			continue
		}
		parts = append(parts, fmt.Sprintf("%s: %s", a.ID, strings.Join(a.Models, ", ")))
		for _, m := range a.Models {
			if !slices.Contains(enum, m) {
				enum = append(enum, m)
			}
		}
	}
	if !allListed {
		enum = nil
	}
	if len(parts) > 0 {
		desc = " Models by agent: " + strings.Join(parts, "; ") + "."
	}
	return enum, desc
}

// spawnSchema is the spawn_agent input schema; `agent` appears only when
// at least one ACP agent is available.
func spawnSchema(agents []plugins.Agent) (json.RawMessage, error) {
	return spawnSchemaFor(agents, false)
}

// spawnTierAutoDescription describes the tier property while the router can
// choose (route_api): auto is accepted and is the default.
const spawnTierAutoDescription = "Who does the task. auto (the default): the router picks the model tier or a flat-rate local agent " +
	"by task difficulty and price. Or choose a model tier by task difficulty."

// spawnSchemaFor is spawnSchema; with auto the tier property gains "auto" and
// becomes optional (its default).
func spawnSchemaFor(agents []plugins.Agent, auto bool) (json.RawMessage, error) {
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
		enum, desc := modelChoices(agents)
		model := map[string]any{
			"type": "string",
			"description": "Optional, only with agent: the model that external agent should use. Omit for the agent's default." +
				desc,
		}
		if len(enum) > 0 {
			model["enum"] = enum
		}
		props["env"] = map[string]any{
			"type": "object", "additionalProperties": map[string]any{"type": "string"},
			"description": "Optional, only with agent: environment variables for that external agent's process, each " +
				"NAME: \"secret:<name>\" naming a secret the user stored through request_input. The harness fills the value in.",
		}
		props["model"] = model
		props["agent"] = map[string]any{
			"type": "string", "enum": ids,
			"description": "Optional. Run the task on an external local coding agent (a separate harness on the user's machine, " +
				"with its own tools and model) instead of a built-in sub-agent. Use it when the user asks for one by name or when " +
				"another harness suits a self-contained coding task. Available: " + agentList(agents) + ". Omit for a normal sub-agent.",
		}
	}
	required := []string{"role", "title", "task", "tier"}
	if auto {
		props["tier"] = map[string]any{
			"type": "string", "enum": []string{TierAuto, "fast", "balanced", "deep"}, "description": spawnTierAutoDescription,
		}
		required = required[:3]
	}
	return json.Marshal(map[string]any{
		"type": "object", "properties": props, "required": required,
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
