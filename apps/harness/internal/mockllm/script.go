package mockllm

import (
	"strings"
)

type call struct {
	Name  string
	Input map[string]any
}

type reply struct {
	Text  string
	Calls []call
}

// plan derives the next assistant reply purely from the request.
func plan(r *request) reply {
	if r.hasTool("save_note") {
		return orchestratorReply(r)
	}
	return subAgentReply(r)
}

func orchestratorReply(r *request) reply {
	anchor := r.lastUserTextIndex()
	if anchor < 0 {
		return reply{Text: "Hello! Tell me what you would like to do in this project."}
	}
	ask := r.Messages[anchor].text()
	if agents := r.spawnAgentChoices(); len(agents) > 0 && strings.Contains(ask, acpMarker) {
		return acpReply(r, anchor, ask, agents[0])
	}
	if strings.Contains(strings.ToLower(ask), "quick") {
		return reply{Text: quickAnswer(ask)}
	}
	switch r.assistantCountFrom(anchor) {
	case 0:
		return reply{Text: planningText(ask), Calls: spawnCalls(ask)}
	case 1:
		return reply{
			Text: "The sub-agents have reported back, so I will record the goal before summarizing.",
			Calls: []call{{Name: "save_note", Input: map[string]any{
				"title": "Current goal", "content": "User request: " + clip(ask, 300) + "\nStatus: sub-agent reports received; summary delivered.",
			}}},
		}
	}
	return reply{Text: finalAnswer(r, anchor)}
}

func subAgentReply(r *request) reply {
	role := r.role()
	var steps []func() reply
	if r.hasTool("list_dir") {
		steps = append(steps, func() reply {
			return reply{
				Text:  "I will start by listing the project folder.",
				Calls: []call{{Name: "list_dir", Input: map[string]any{"path": "."}}},
			}
		})
	}
	nested := len(r.Messages) > 0 && strings.Contains(r.Messages[0].text(), "[nested]")
	marked := len(r.Messages) > 0 && strings.Contains(r.Messages[0].text(), "[write]")
	switch {
	case marked && r.hasTool("write_file"):
		steps = append(steps, func() reply {
			return reply{
				Text: "I will leave a short note in the project folder.",
				Calls: []call{{Name: "write_file", Input: map[string]any{
					"path": "octo-demo-note.md", "content": "# Note from the " + role + "\n\nWritten by the mock model.\n",
				}}},
			}
		})
	case role == "Systems architect" && r.hasTool("spawn_agent") && !nested:
		steps = append(steps, func() reply {
			return reply{
				Text: "The design has risky corners, so I will hand failure-mode analysis to a specialist.",
				Calls: []call{{Name: "spawn_agent", Input: map[string]any{
					"role": "Risk analyst", "tier": "fast", "title": "Enumerate failure modes",
					"task": "[nested] Enumerate the most likely failure modes of the proposed change: concurrency, partial " +
						"failure, and data loss. Reply with a short bullet list ordered by likelihood, each with a one-line mitigation.",
				}}},
			}
		})
	case r.hasTool("read_file"):
		steps = append(steps, func() reply {
			file := pickFile(r)
			return reply{
				Text:  "Now I will read " + file + " to ground my report.",
				Calls: []call{{Name: "read_file", Input: map[string]any{"path": file}}},
			}
		})
	}
	if n := r.assistantCountFrom(0); n < len(steps) {
		return steps[n]()
	}
	return reply{Text: subAgentReport(r, role)}
}

// pickFile chooses the first file-looking entry from the latest list_dir result.
func pickFile(r *request) string {
	if len(r.Messages) > 0 {
		for _, b := range r.Messages[len(r.Messages)-1].blocks() {
			if b.Type != "tool_result" {
				continue
			}
			for _, line := range strings.Split(b.resultText(), "\n") {
				line = strings.TrimSpace(line)
				if line != "" && !strings.HasSuffix(line, "/") && strings.Contains(line, ".") && !strings.HasPrefix(line, ".") {
					return line
				}
			}
		}
	}
	return "README.md"
}

func clip(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > n {
		return string(r[:n]) + "..."
	}
	return s
}
