package mockllm

import (
	"regexp"
	"strings"
)

// Markers (in the user's request, which the orchestrator repeats in every
// sub-agent task) that make a built-in sub-agent use tools for the v7 flows:
//
//	[write:PATH]     write_file PATH (PATH may hold {role}: the role, lower-cased, dashes)
//	[rewrite:PATH]   write_file PATH twice, with different content
//	[bash:COMMAND]   bash COMMAND (no ']' in it)
//	[usekey:NAME]    bash with env MY_KEY=secret:NAME that prints the variable's length and value
//	[ask]            request_input for an API key (secret) and a region (text)
//
// An orchestrator turn whose request holds [form] calls request_input itself
// (a secret field and a text field) and then reports what came back.
var (
	writeMarker   = regexp.MustCompile(`\[write:([^\]]+)\]`)
	rewriteMarker = regexp.MustCompile(`\[rewrite:([^\]]+)\]`)
	bashMarker    = regexp.MustCompile(`\[bash:([^\]]+)\]`)
	useKeyMarker  = regexp.MustCompile(`\[usekey:([^\]]+)\]`)
)

const (
	askMarker  = "[ask]"
	formMarker = "[form]"
)

func rolePath(p, role string) string {
	slug := strings.ToLower(strings.Join(strings.Fields(role), "-"))
	return strings.ReplaceAll(p, "{role}", slug)
}

// v7Steps lists the tool calls the first message asks this sub-agent for.
func v7Steps(r *request, first, role string) []func() reply {
	var steps []func() reply
	call1 := func(text, name string, in map[string]any) func() reply {
		return func() reply { return reply{Text: text, Calls: []call{{Name: name, Input: in}}} }
	}
	if strings.Contains(first, askMarker) && r.hasTool("request_input") {
		steps = append(steps, call1("I need a credential from the user.", "request_input", inputSchemaCall("Credentials", "The task needs an API key.")))
	}
	if r.hasTool("write_file") {
		for _, m := range writeMarker.FindAllStringSubmatch(first, -1) {
			p := rolePath(m[1], role)
			steps = append(steps, call1("I will write "+p+".", "write_file", map[string]any{
				"path": p, "content": "# Note from the " + role + "\n\nfirst version\n",
			}))
		}
		for _, m := range rewriteMarker.FindAllStringSubmatch(first, -1) {
			p := rolePath(m[1], role)
			steps = append(steps,
				call1("I will write "+p+".", "write_file", map[string]any{"path": p, "content": "line one\nline two\n"}),
				call1("I will refine "+p+".", "write_file", map[string]any{"path": p, "content": "line one\nline two changed\nline three\n"}))
		}
	}
	if r.hasTool("bash") {
		for _, m := range bashMarker.FindAllStringSubmatch(first, -1) {
			steps = append(steps, call1("I will run a command.", "bash", map[string]any{"command": strings.TrimSpace(m[1])}))
		}
		for _, m := range useKeyMarker.FindAllStringSubmatch(first, -1) {
			steps = append(steps, call1("I will use the key in a command.", "bash", map[string]any{
				"command": `printf 'len=%s\n' "${#MY_KEY}"; echo "$MY_KEY"`,
				"env":     map[string]any{"MY_KEY": "secret:" + strings.TrimSpace(m[1])},
			}))
		}
	}
	return steps
}

func inputSchemaCall(title, reason string) map[string]any {
	return map[string]any{
		"title": title, "reason": reason,
		"fields": []map[string]any{
			{"id": "api_key", "label": "API key", "kind": "secret", "required": true},
			{"id": "region", "label": "Region", "kind": "text"},
		},
	}
}

// formReply is the orchestrator's [form] flow: ask, then report the result.
func formReply(r *request, anchor int, ask string) reply {
	if r.assistantCountFrom(anchor) == 0 {
		return reply{
			Text:  "I need two values from you before I can continue.",
			Calls: []call{{Name: "request_input", Input: inputSchemaCall("Credentials", "Needed to call the service.")}},
		}
	}
	result := "(no result)"
	for _, m := range r.Messages[anchor+1:] {
		for _, b := range m.blocks() {
			if b.Type == "tool_result" {
				result = strings.TrimSpace(b.resultText())
			}
		}
	}
	return reply{Text: "Form answered: " + clip(result, 300)}
}
