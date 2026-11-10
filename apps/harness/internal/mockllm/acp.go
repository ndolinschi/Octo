package mockllm

import (
	"fmt"
	"regexp"
	"strings"
)

// acpMarker makes the orchestrator delegate one sub-agent to an ACP agent.
const acpMarker = "[acp]"

var bracketMarker = regexp.MustCompile(`\[[a-z-]+\]`)

// acpReply delegates to the first offered ACP agent, then summarizes its report.
func acpReply(r *request, anchor int, ask, agent string) reply {
	if r.assistantCountFrom(anchor) == 0 {
		task := "The user asked: \"" + clip(ask, 160) + "\". Work on it in the project folder and report back with " +
			"what you read, what you changed, and anything left open."
		for _, m := range bracketMarker.FindAllString(ask, -1) {
			if m != acpMarker {
				task += " " + m
			}
		}
		return reply{
			Text: "This fits an external agent, so I will delegate it to " + agent + ".",
			Calls: []call{{Name: "spawn_agent", Input: map[string]any{
				"role": "External agent", "tier": "balanced", "title": "Delegate to " + agent, "agent": agent, "task": task,
			}}},
		}
	}
	return reply{Text: acpSummary(r, anchor, ask, agent)}
}

func acpSummary(r *request, anchor int, ask, agent string) string {
	report, outcome := "(no report)", "reported"
	for _, m := range r.Messages[anchor+1:] {
		for _, b := range m.blocks() {
			if b.Type == "tool_result" {
				report, outcome = strings.TrimSpace(b.resultText()), "reported"
				if b.IsError {
					outcome = "failed"
				}
			}
		}
	}
	return "## Summary\n\n" +
		fmt.Sprintf("I delegated \"%s\" to the external agent `%s`; it %s.\n\n", clip(ask, 80), agent, outcome) +
		"> " + clip(report, 400) + "\n"
}
