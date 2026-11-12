package mockllm

import (
	"fmt"
	"regexp"
	"strings"
)

// notesMarker asks the orchestrator to check how project notes reach the model
// (M5): "[notes: NEEDLE]". The mock opens the first note of the index with
// read_note, then reports what the system prompt held: how many index lines,
// whether the "N more notes" line is there, whether NEEDLE (a marker only a
// note body has) is in the prompt, and the start of what read_note returned.
var notesMarker = regexp.MustCompile(`\[notes:\s*([^\]]+)\]`)

var noteIndexLine = regexp.MustCompile(`(?m)^(nte_[a-z0-9]+) · `)

func notesReply(r *request, anchor int, ask string) (reply, bool) {
	m := notesMarker.FindStringSubmatch(ask)
	if m == nil || !r.hasTool("read_note") {
		return reply{}, false
	}
	needle := strings.TrimSpace(m[1])
	sys := r.system()
	if r.assistantCountFrom(anchor) == 0 {
		ids := noteIndexLine.FindStringSubmatch(sys)
		if ids == nil {
			return reply{Text: "Notes check: the prompt has no notes index."}, true
		}
		return reply{Text: "Let me open the first note of the index.", Calls: []call{{Name: "read_note", Input: map[string]any{"id": ids[1]}}}}, true
	}
	result := "(no result)"
	for _, msg := range r.Messages[anchor+1:] {
		for _, b := range msg.blocks() {
			if b.Type == "tool_result" {
				result = strings.TrimSpace(b.resultText())
			}
		}
	}
	return reply{Text: fmt.Sprintf("Notes check: index_lines=%d more_line=%t needle_in_prompt=%t read_note=%s",
		len(noteIndexLine.FindAllString(sys, -1)), strings.Contains(sys, " more notes — use search_notes"),
		strings.Contains(sys, needle), clip(strings.Join(strings.Fields(result), " "), 60))}, true
}
