package mockllm

import "strings"

// ctxMarker in the latest user request makes the mock model answer with what it was sent: the start of every
// user text of the request, in order. A test or e2e script reads it to see which conversation (which session)
// the harness rebuilt for the request.
const ctxMarker = "[ctx]"

// ctxReply answers a request that carries ctxMarker with "ctx: <user texts>"; ok is false otherwise.
func ctxReply(r *request) (reply, bool) {
	anchor := r.lastUserTextIndex()
	if anchor < 0 || !strings.Contains(r.Messages[anchor].text(), ctxMarker) || r.assistantCountFrom(anchor) != 0 {
		return reply{}, false
	}
	var seen []string
	for _, m := range r.Messages {
		if t := strings.TrimSpace(m.text()); m.Role == "user" && t != "" {
			seen = append(seen, clip(strings.Join(strings.Fields(t), " "), 60))
		}
	}
	return reply{Text: "ctx: " + strings.Join(seen, " | ")}, true
}
