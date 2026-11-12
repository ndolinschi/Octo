package mockllm

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
)

// Markers (in the user's request, which the orchestrator repeats in every
// sub-agent task) that make a built-in sub-agent use tools for the v7 flows:
//
//	[write:PATH]     write_file PATH (PATH may hold {role}: the role, lower-cased, dashes)
//	[rewrite:PATH]   write_file PATH twice, with different content
//	[bash:COMMAND]   bash COMMAND (no ']' in it)
//	[edit:PATH|OLD|NEW]  edit PATH, replacing OLD with NEW (no '|' or ']' in them)
//	[glob:PATTERN]   glob PATTERN
//	[fetch:URL]      web_fetch URL (when the tool is offered)
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
	editMarker    = regexp.MustCompile(`\[edit:([^|\]]+)\|([^|\]]*)\|([^\]]*)\]`)
	globMarker    = regexp.MustCompile(`\[glob:([^\]]+)\]`)
	fetchMarker   = regexp.MustCompile(`\[fetch:([^\]]+)\]`)
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
	if r.hasTool("edit") {
		for _, m := range editMarker.FindAllStringSubmatch(first, -1) {
			steps = append(steps, call1("I will edit "+m[1]+".", "edit", map[string]any{"path": rolePath(m[1], role), "old_string": m[2], "new_string": m[3]}))
		}
	}
	if r.hasTool("glob") {
		for _, m := range globMarker.FindAllStringSubmatch(first, -1) {
			steps = append(steps, call1("I will look for files.", "glob", map[string]any{"pattern": strings.TrimSpace(m[1])}))
		}
	}
	if r.hasTool("web_fetch") {
		for _, m := range fetchMarker.FindAllStringSubmatch(first, -1) {
			steps = append(steps, call1("I will fetch a page.", "web_fetch", map[string]any{"url": strings.TrimSpace(m[1])}))
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

// digestMarker is how the harness's memory digest prompt introduces itself.
const digestMarker = "You maintain the memory of a software project"

// Markers in the user's request that the mock's digest turns into JSON:
//
//	[fact: TEXT]  or  [fact: TEXT | supersedes: OLD TEXT]
//	[goal: TEXT]  [quote: TEXT]  [decision: TEXT]  [outcome: TEXT]
var (
	factMarker     = regexp.MustCompile(`\[fact:\s*([^\]|]+?)\s*(?:\|\s*supersedes:\s*([^\]]+?)\s*)?\]`)
	goalMarker     = regexp.MustCompile(`\[goal:\s*([^\]]+?)\s*\]`)
	quoteMarker    = regexp.MustCompile(`\[quote:\s*([^\]]+?)\s*\]`)
	decisionMarker = regexp.MustCompile(`\[decision:\s*([^\]]+?)\s*\]`)
	// [continues: TEXT] attaches the exchange to the listed earlier task whose line holds TEXT.
	continuesMarker = regexp.MustCompile(`\[continues:\s*([^\]]+?)\s*\]`)
	outcomeMarker   = regexp.MustCompile(`\[outcome:\s*([^\]]+?)\s*\]`)
)

// digestReply answers the digest call: a JSON object built from the markers of
// the request it was given.
func digestReply(r *request) reply {
	text := ""
	if n := len(r.Messages); n > 0 {
		text = r.Messages[n-1].text()
	}
	full := text
	if i := strings.Index(text, "User request:"); i >= 0 {
		text = text[i:]
	}
	first := func(re *regexp.Regexp) string {
		if m := re.FindStringSubmatch(text); m != nil {
			return m[1]
		}
		return ""
	}
	all := func(re *regexp.Regexp) []string {
		out := []string{}
		for _, m := range re.FindAllStringSubmatch(text, -1) {
			out = append(out, m[1])
		}
		return out
	}
	facts := []map[string]string{}
	for _, m := range factMarker.FindAllStringSubmatch(text, -1) {
		facts = append(facts, map[string]string{"text": m[1], "supersedes": m[2]})
	}
	continues := ""
	if m := continuesMarker.FindStringSubmatch(text); m != nil {
		for _, line := range strings.Split(full, "\n") {
			if i := strings.Index(line, "["); strings.HasPrefix(line, "- [") && i >= 0 && strings.Contains(line, m[1]) {
				continues = line[i+1 : strings.Index(line, "]")]
				break
			}
		}
	}
	out := map[string]any{
		"continues": continues,
		"goal":      first(goalMarker), "outcome": first(outcomeMarker), "quotes": all(quoteMarker), "decisions": all(decisionMarker),
		"constraints": []string{}, "acceptance": []string{}, "facts": facts,
	}
	b, _ := json.Marshal(out)
	return reply{Text: string(b)}
}

// Orchestrator markers that make one memory tool call, then report its result:
//
//	[search: QUERY]            memory_search {query}
//	[search-after: DATE QUERY] memory_search with after=DATE
//	[recall: ID]               recall_message {id}
//	[mem-create: PATH | SUMMARY | TEXT]   memory create
//	[task-update: TITLE]       task_update {title}
var (
	searchMarker      = regexp.MustCompile(`\[search:\s*([^\]]+?)\s*\]`)
	searchAfterMarker = regexp.MustCompile(`\[search-after:\s*(\S+)\s+([^\]]+?)\s*\]`)
	recallMarker      = regexp.MustCompile(`\[recall:\s*(\d+)\s*\]`)
	memCreateMarker   = regexp.MustCompile(`\[mem-create:\s*([^|\]]+?)\s*\|\s*([^|\]]+?)\s*\|\s*([^\]]+?)\s*\]`)
	taskUpdateMarker  = regexp.MustCompile(`\[task-update:\s*([^\]]+?)\s*\]`)
)

func memoryToolCall(ask string) (call, bool) {
	switch {
	case searchAfterMarker.MatchString(ask):
		m := searchAfterMarker.FindStringSubmatch(ask)
		return call{Name: "memory_search", Input: map[string]any{"query": m[2], "after": m[1]}}, true
	case searchMarker.MatchString(ask):
		return call{Name: "memory_search", Input: map[string]any{"query": searchMarker.FindStringSubmatch(ask)[1]}}, true
	case recallMarker.MatchString(ask):
		n, _ := strconv.Atoi(recallMarker.FindStringSubmatch(ask)[1])
		return call{Name: "recall_message", Input: map[string]any{"id": n}}, true
	case memCreateMarker.MatchString(ask):
		m := memCreateMarker.FindStringSubmatch(ask)
		return call{Name: "memory", Input: map[string]any{"command": "create", "path": m[1], "summary": m[2], "file_text": m[3]}}, true
	case taskUpdateMarker.MatchString(ask):
		return call{Name: "task_update", Input: map[string]any{"title": taskUpdateMarker.FindStringSubmatch(ask)[1]}}, true
	}
	return call{}, false
}

// memoryReply is the orchestrator's one-tool-call flow for those markers.
func memoryReply(r *request, anchor int, ask string) (reply, bool) {
	c, ok := memoryToolCall(ask)
	if !ok || !r.hasTool(c.Name) {
		return reply{}, false
	}
	if r.assistantCountFrom(anchor) == 0 {
		return reply{Text: "Let me use my memory.", Calls: []call{c}}, true
	}
	result := "(no result)"
	for _, m := range r.Messages[anchor+1:] {
		for _, b := range m.blocks() {
			if b.Type == "tool_result" {
				result = strings.TrimSpace(b.resultText())
			}
		}
	}
	return reply{Text: "Memory result: " + result}, true
}
