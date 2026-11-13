package diff

import (
	"fmt"
	"strings"
)

// Unified renders the difference between old and new as one unified-diff hunk
// for the approval card: the common leading and trailing lines are trimmed
// (ctx lines of context stay), everything between is shown as removed and
// added. Empty when they are equal; cut at maxBytes with a marker line.
func Unified(name, old, new string, ctx, maxBytes int) string {
	if old == new {
		return ""
	}
	a, b := splitKeep(old), splitKeep(new)
	pre := 0
	for pre < len(a) && pre < len(b) && a[pre] == b[pre] {
		pre++
	}
	suf := 0
	for suf < len(a)-pre && suf < len(b)-pre && a[len(a)-1-suf] == b[len(b)-1-suf] {
		suf++
	}
	start := max(pre-ctx, 0)
	// The trailing context is the same lines on both sides.
	tail := min(ctx, suf)
	endA, endB := len(a)-suf+tail, len(b)-suf+tail
	var out strings.Builder
	fmt.Fprintf(&out, "--- a/%s\n+++ b/%s\n", name, name)
	fmt.Fprintf(&out, "@@ -%d,%d +%d,%d @@\n", start+1, endA-start, start+1, endB-start)
	line := func(prefix string, l string) {
		out.WriteString(prefix)
		out.WriteString(strings.TrimSuffix(l, "\n"))
		out.WriteString("\n")
		if !strings.HasSuffix(l, "\n") {
			out.WriteString("\\ No newline at end of file\n")
		}
	}
	for _, l := range a[start:pre] {
		line(" ", l)
	}
	for _, l := range a[pre : len(a)-suf] {
		line("-", l)
	}
	for _, l := range b[pre : len(b)-suf] {
		line("+", l)
	}
	for _, l := range a[len(a)-suf : len(a)-suf+tail] {
		line(" ", l)
	}
	s := out.String()
	if maxBytes > 0 && len(s) > maxBytes {
		cut := maxBytes
		for cut > 0 && s[cut-1] != '\n' {
			cut--
		}
		s = s[:cut] + "[... diff cut ...]\n"
	}
	return s
}

// splitKeep splits s into lines that keep their newline.
func splitKeep(s string) []string {
	var out []string
	for s != "" {
		i := strings.IndexByte(s, '\n')
		if i < 0 {
			out = append(out, s)
			break
		}
		out = append(out, s[:i+1])
		s = s[i+1:]
	}
	return out
}
