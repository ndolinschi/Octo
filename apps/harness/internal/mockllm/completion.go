package mockllm

import (
	"regexp"
	"strings"
)

// completionMarker is how the harness's inline-completion prompt introduces itself.
const completionMarker = "You complete code at the cursor"

// completeMarker in the text before the cursor sets the insertion:
// [complete: foo(\n)] (the two characters \n become a newline).
var completeMarker = regexp.MustCompile(`\[complete:\s*([^\]]*?)\s*\]`)

// completionReply answers an inline-completion call: the insertion a marker in
// the request asks for, else a fixed one-line continuation.
func completionReply(r *request) reply {
	text := ""
	if n := len(r.Messages); n > 0 {
		text = r.Messages[n-1].text()
	}
	if m := completeMarker.FindStringSubmatch(text); m != nil {
		return reply{Text: strings.ReplaceAll(m[1], `\n`, "\n")}
	}
	return reply{Text: "completed_by_mock()"}
}
