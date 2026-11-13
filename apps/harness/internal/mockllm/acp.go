package mockllm

import (
	"fmt"
	"regexp"
	"strings"
)

// acpMarker makes the orchestrator delegate one sub-agent to an ACP agent.
const acpMarker = "[acp]"

// modelMarker, "[model:NAME]", passes NAME as spawn_agent's `model`.
var modelMarker = regexp.MustCompile(`\[model:([A-Za-z0-9._:/@+-]+)\]`)

// envMarker, "[env:NAME=secretname]", passes env {NAME: "secret:secretname"} to spawn_agent.
var envMarker = regexp.MustCompile(`\[env:([A-Z_][A-Z0-9_]*)=([A-Za-z][A-Za-z0-9_.-]*)\]`)

var bracketMarker = regexp.MustCompile(`\[[a-z-]+\]`)

// acpReply delegates to the first offered ACP agent, then summarizes its report.
func acpReply(r *request, anchor int, ask, agent string) reply {
	if r.assistantCountFrom(anchor) == 0 {
		model := modelMarker.FindStringSubmatch(ask)
		envs := envMarker.FindAllStringSubmatch(ask, -1)
		ask = envMarker.ReplaceAllString(ask, "")
		ask = strings.Join(strings.Fields(modelMarker.ReplaceAllString(ask, "")), " ")
		task := "The user asked: \"" + clip(ask, 160) + "\". Work on it in the project folder and report back with " +
			"what you read, what you changed, and anything left open."
		for _, m := range bracketMarker.FindAllString(ask, -1) {
			if m != acpMarker {
				task += " " + m
			}
		}
		input := map[string]any{
			"role": "External agent", "tier": "balanced", "title": "Delegate to " + agent, "agent": agent, "task": task,
		}
		if model != nil {
			input["model"] = model[1]
		}
		if len(envs) > 0 {
			env := map[string]any{}
			for _, e := range envs {
				env[e[1]] = "secret:" + e[2]
			}
			input["env"] = env
		}
		return reply{
			Text:  "This fits an external agent, so I will delegate it to " + agent + ".",
			Calls: []call{{Name: "spawn_agent", Input: input}},
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
