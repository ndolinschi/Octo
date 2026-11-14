package orchestrator

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/mcp"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
)

// spawnExample is a complete spawn_agent call, quoted in the refusal of a
// malformed call and in the MCP server's instructions. An agent that calls the
// tool knowing only its name (Claude Code loads MCP tool schemas on demand, so
// its first call can be a guess) then has what it needs to get the retry right.
const spawnExample = `{"role": "Code explorer", "title": "Count lines of main.go", ` +
	`"task": "Count the lines of main.go in the project folder and report just the number.", "tier": "fast"}`

// spawnRefusal is the tool error of a spawn_agent call that lacks a required
// argument or names an unknown tier: what is wrong, what the tool takes and an
// example. Plain text (it is shown to people too).
func spawnRefusal(in spawnInput, routed bool) string {
	var b strings.Builder
	tiers := "fast|balanced|deep"
	if routed {
		b.WriteString("spawn_agent requires role, title and task, and tier if given (auto|fast|balanced|deep).")
		tiers = "auto|fast|balanced|deep"
	} else {
		b.WriteString("spawn_agent requires role, title, task and tier (fast|balanced|deep).")
	}
	var missing []string
	for _, f := range []struct{ name, val string }{{"role", in.Role}, {"title", in.Title}, {"task", in.Task}} {
		if f.val == "" {
			missing = append(missing, f.name)
		}
	}
	if in.Tier == "" && !routed {
		missing = append(missing, "tier")
	}
	if len(missing) > 0 {
		b.WriteString(" Missing: " + strings.Join(missing, ", ") + ".")
	}
	if in.Tier != "" {
		if valid := slices.Contains(strings.Split(tiers, "|"), in.Tier); !valid {
			fmt.Fprintf(&b, " tier %q is not one of %s.", in.Tier, strings.ReplaceAll(tiers, "|", ", "))
		}
	}
	b.WriteString(" No sub-agent was started. Call spawn_agent again with all of them: role (a specialist role), " +
		"title (a short task title), task (a self-contained brief that says what report to return; the sub-agent sees nothing else)")
	if routed {
		b.WriteString(" and optionally tier (auto by default).")
	} else {
		b.WriteString(" and tier (fast for lookups and simple edits, balanced for normal engineering, deep for hard design or debugging).")
	}
	b.WriteString(" Example arguments: " + spawnExample)
	return b.String()
}

// spawnArgsGuidance is the ACP orchestrator briefing's line on spawn_agent's
// arguments. The agent may see the tool only by name until it loads the
// schema, and a guess from the rest of the briefing (task and tier) is refused.
func (rt *runtime) spawnArgsGuidance() string {
	if rt.routeEnabled() {
		return "spawn_agent takes role (a specialist role, e.g. \"Code explorer\"), title (a short task title) and task " +
			"(the self-contained brief), all three required, and optionally tier. Example arguments: " + spawnExample
	}
	return "spawn_agent takes role (a specialist role, e.g. \"Code explorer\"), title (a short task title), task " +
		"(the self-contained brief) and tier, all four required. Example arguments: " + spawnExample
}

// Instructions is the MCP server's initialize "instructions": the harness tools
// and the arguments each takes, so an agent that has not loaded a tool's schema
// still calls it right.
func (b mcpBackend) Instructions(bind mcp.Binding) string {
	s, err := b.session(bind)
	if err != nil {
		return ""
	}
	s.mu.Lock()
	reg, agentID := s.reg, s.agentID
	s.mu.Unlock()
	if reg == nil || agentID != bind.AgentID {
		return ""
	}
	return mcpInstructions(reg.All())
}

// maxEnumShown is the most enum values an argument's summary lists.
const maxEnumShown = 8

type schemaSummary struct {
	Properties map[string]struct {
		Type        string   `json:"type"`
		Description string   `json:"description"`
		Enum        []string `json:"enum"`
	} `json:"properties"`
	Required []string `json:"required"`
}

// mcpInstructions lists every tool with its required arguments (described)
// and its optional ones (named), from the tools' own schemas.
func mcpInstructions(defs []tools.Def) string {
	var b strings.Builder
	b.WriteString("These are the harness's tools for this project. Each line gives a tool, the arguments it requires " +
		"(with what they mean) and its optional ones. Pass arguments by exactly these names: a call that leaves out a " +
		"required argument is refused. If your client loads tool schemas on demand, load the tool's schema before " +
		"the first call, or follow this list.\n")
	for _, d := range defs {
		var sc schemaSummary
		_ = json.Unmarshal(d.InputSchema, &sc)
		var req, opt []string
		for _, name := range sc.Required {
			p, ok := sc.Properties[name]
			if !ok {
				continue
			}
			req = append(req, name+" ("+argSummary(p.Type, p.Description, p.Enum)+")")
		}
		for name, p := range sc.Properties {
			if slices.Contains(sc.Required, name) {
				continue
			}
			if len(p.Enum) > 0 && len(p.Enum) <= maxEnumShown {
				name += " (" + strings.Join(p.Enum, "|") + ")"
			}
			opt = append(opt, name)
		}
		slices.Sort(opt)
		line := "- " + d.Name + ": "
		switch {
		case len(req) > 0:
			line += "requires " + strings.Join(req, ", ")
		default:
			line += "no required arguments"
		}
		if len(opt) > 0 {
			line += "; optional: " + strings.Join(opt, ", ")
		}
		line += "."
		if d.Name == ToolSpawnAgent {
			line += " Example arguments: " + spawnExample
		}
		b.WriteString(line + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

func argSummary(typ, desc string, enum []string) string {
	var parts []string
	if len(enum) > 0 && len(enum) <= maxEnumShown {
		parts = append(parts, "one of "+strings.Join(enum, ", "))
	} else if typ != "" {
		parts = append(parts, typ)
	}
	if desc = strings.TrimSpace(desc); desc != "" {
		parts = append(parts, clip(strings.TrimSuffix(desc, "."), 160))
	}
	return strings.Join(parts, ": ")
}
