package orchestrator

import (
	"fmt"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
)

// flattenContent renders tool-call content as plain text: text blocks as is,
// diffs as a small -/+ listing, terminals as a placeholder.
func flattenContent(items []acp.ToolContent) string {
	var parts []string
	for _, it := range items {
		switch it.Type {
		case "content":
			if it.Content != nil && it.Content.Text != "" {
				parts = append(parts, it.Content.Text)
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
