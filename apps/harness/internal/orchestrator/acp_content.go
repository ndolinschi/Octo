package orchestrator

import (
	"fmt"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
)

// flattenContent renders tool-call content as plain text: text blocks as is
// (without a fence around the whole block, see unfence), diffs as a small -/+
// listing, terminals as a placeholder.
func flattenContent(items []acp.ToolContent) string {
	var parts []string
	for _, it := range items {
		switch it.Type {
		case "content":
			if it.Content != nil && it.Content.Text != "" {
				parts = append(parts, unfence(it.Content.Text))
			}
		case "diff":
			parts = append(parts, formatDiff(it))
		case "terminal":
			parts = append(parts, "[terminal "+it.TerminalID+"]")
		}
	}
	return strings.Join(parts, "\n")
}

func formatDiff(it acp.ToolContent) string {
	var b strings.Builder
	fmt.Fprintf(&b, "diff %s\n", it.Path)
	if it.OldText != nil {
		writePrefixed(&b, "-", *it.OldText)
	}
	writePrefixed(&b, "+", it.NewText)
	return strings.TrimRight(b.String(), "\n")
}

func writePrefixed(b *strings.Builder, prefix, text string) {
	for _, line := range strings.Split(strings.TrimSuffix(text, "\n"), "\n") {
		b.WriteString(prefix + line + "\n")
	}
}

// unfence returns the body of a text that is one Markdown code fence and
// nothing else ("```[info]\n...\n```"), else the text unchanged. Claude Code's
// ACP adapter wraps every tool result that way for display (a refused
// spawn_agent call arrived as "```\nspawn_agent requires ...\n```"); the
// harness stores and shows tool results as plain text.
func unfence(text string) string {
	const fence = "```"
	if !strings.HasPrefix(text, fence) {
		return text
	}
	nl := strings.IndexByte(text, '\n')
	if nl < 0 || strings.Contains(text[len(fence):nl], "`") {
		return text
	}
	body, ok := strings.CutSuffix(strings.TrimRight(text[nl+1:], "\n"), fence)
	if !ok {
		return text
	}
	if body != "" && !strings.HasSuffix(body, "\n") {
		return text // the closing fence must be on its own line
	}
	body = strings.TrimSuffix(body, "\n")
	for _, line := range strings.Split(body, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), fence) {
			return text // more than one block: Markdown on purpose
		}
	}
	return body
}
