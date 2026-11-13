package mockllm

import (
	"fmt"
	"strings"
)

func quickAnswer(ask string) string {
	return fmt.Sprintf("Here is a **quick** answer to \"%s\".\n\n- No delegation needed for this one.\n- Ask for a deeper pass and I will bring in sub-agents.", clip(ask, 80))
}

func planningText(ask string) string {
	return fmt.Sprintf("I will split \"%s\" into three parallel tracks: map the repository, implement the change, and review the design for risks.", clip(ask, 100))
}

func spawnCalls(ask string) []call {
	req := clip(ask, 160)
	return []call{
		{Name: "spawn_agent", Input: map[string]any{
			"role": "Code explorer", "tier": "fast", "title": "Map the repository layout",
			"task": "The user asked: \"" + req + "\". Map the repository layout so the implementation work can start quickly. " +
				"List the top-level directories, identify entry points and where tests live, and note anything that looks relevant to the request. " +
				"Do not modify files. Reply with bullets: key directories, entry points, test layout, open questions.",
		}},
		{Name: "spawn_agent", Input: map[string]any{
			"role": "Implementation engineer", "tier": "balanced", "title": "Implement the change",
			"task": "The user asked: \"" + req + "\". Work out the smallest correct implementation of this request in the attached folder. " +
				"Read the relevant files, describe the exact edits you would make, and make them if they are low risk. " +
				"Reply with: files changed or to change, a one-paragraph rationale, and how to verify.",
		}},
		{Name: "spawn_agent", Input: map[string]any{
			"role": "Systems architect", "tier": "deep", "title": "Review design and risks",
			"task": "The user asked: \"" + req + "\". Review the design implications of this request: boundaries, data flow, and failure modes. " +
				"Delegate narrow analysis if it helps. Reply with a compact assessment: recommended approach, top risks, and what to decide first.",
		}},
	}
}

func subAgentReport(r *request, role string) string {
	task := ""
	if len(r.Messages) > 0 {
		task = clip(r.Messages[0].text(), 90)
	}
	return fmt.Sprintf("As the %s, I inspected the project and have a compact report.\n\n"+
		"- **Scope:** %s\n- **Findings:** the layout is conventional and the relevant code is easy to locate.\n- **Next step:** proceed with the plan; no blockers.",
		role, task)
}

// finalAnswer summarizes the sub-agent reports from the first tool-result message.
func finalAnswer(r *request, anchor int) string {
	roles := map[string]string{}
	tiers := map[string]string{}
	for _, b := range r.Messages[anchor+1].blocks() {
		if b.Type == "tool_use" {
			in := struct{ Role, Tier string }{}
			_ = jsonUnmarshal(b.Input, &in)
			roles[b.ID], tiers[b.ID] = in.Role, in.Tier
		}
	}
	var bullets, rows strings.Builder
	for _, b := range r.Messages[anchor+2].blocks() {
		if b.Type != "tool_result" {
			continue
		}
		first, _, _ := strings.Cut(strings.TrimSpace(b.resultText()), "\n")
		outcome := "reported"
		if b.IsError {
			outcome = "failed"
		}
		fmt.Fprintf(&bullets, "- **%s:** %s\n", roles[b.ToolUseID], clip(first, 110))
		fmt.Fprintf(&rows, "| %s | %s | %s |\n", roles[b.ToolUseID], tiers[b.ToolUseID], outcome)
	}
	return "## Summary\n\n" +
		fmt.Sprintf("I delegated \"%s\" to three sub-agents and combined their reports.\n\n", clip(r.Messages[anchor].text(), 80)) +
		bullets.String() +
		"\n| Agent | Tier | Outcome |\n| --- | --- | --- |\n" + rows.String() +
		"\nTo see the current state of the working tree:\n\n```bash\ngit status --short\n```\n"
}

// autoMarker makes the orchestrator spawn one sub-agent without naming a tier
// (spawn_agent's default, "auto", while a router can choose).
const autoMarker = "[auto]"

func autoSpawnCalls(ask string) []call {
	req := clip(strings.ReplaceAll(ask, autoMarker, ""), 160)
	return []call{{Name: "spawn_agent", Input: map[string]any{
		"role": "Code explorer", "title": "Look into the request",
		"task": "The user asked: \"" + strings.TrimSpace(req) + "\". Look into it in the attached folder and reply with a short bullet list of findings.",
	}}}
}
