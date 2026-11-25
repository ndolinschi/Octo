package fakeacp

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
)

// digestMarker is how the harness's task-digest prompt introduces itself.
const digestMarker = "You maintain the memory of a software project"

var digestMarkers = struct{ goal, state, open, decision, constraint, acceptance *regexp.Regexp }{
	goal:       regexp.MustCompile(`\[goal:\s*([^\]]+?)\s*\]`),
	state:      regexp.MustCompile(`\[state:\s*([^\]]+?)\s*\]`),
	open:       regexp.MustCompile(`\[open:\s*([^\]]+?)\s*\]`),
	decision:   regexp.MustCompile(`\[decision:\s*([^\]]+?)\s*\]`),
	constraint: regexp.MustCompile(`\[constraint:\s*([^\]]+?)\s*\]`),
	acceptance: regexp.MustCompile(`\[acceptance:\s*([^\]]+?)\s*\]`),
}

// digest answers the harness's digest prompt with JSON built from the markers
// of the user request it quotes: [goal: ..] [state: ..] [open: ..] [decision: ..]
// [constraint: ..] [acceptance: ..], [met] / [unmet]. OCTO_FAKEACP_DIGEST=fail
// refuses it, =garbage answers with text that is not JSON.
func (a *agent) digest(prompt string) string {
	switch os.Getenv(EnvDigest) {
	case "fail":
		return "refusal"
	case "garbage":
		a.say("I could not make a digest of that.")
		return "end_turn"
	}
	text := prompt
	if i := strings.LastIndex(prompt, "User request:\n"); i >= 0 {
		text = prompt[i:]
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
	out := map[string]any{
		"goal": first(digestMarkers.goal), "state": first(digestMarkers.state), "open_questions": all(digestMarkers.open),
		"decisions": all(digestMarkers.decision), "constraints": all(digestMarkers.constraint), "acceptance": all(digestMarkers.acceptance),
		"quotes": []string{}, "facts": []string{}, "outcome": "", "continues": "",
	}
	switch {
	case strings.Contains(text, "[met]"):
		out["goal_met"] = true
	case strings.Contains(text, "[unmet]"):
		out["goal_met"] = false
	}
	b, _ := json.Marshal(out)
	a.say(string(b))
	return "end_turn"
}
