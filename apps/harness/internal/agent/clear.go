package agent

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/anthropics/anthropic-sdk-go/v2"
)

// ClearPolicy replaces old tool results with one-line stubs once a request
// grows past a share of the model's window, before anything is summarised
// (Anthropic's context editing, applied by the client). The stored messages are
// never touched: only the copy the loop sends.
type ClearPolicy struct {
	// WindowTokens is the model's context window.
	WindowTokens int64
	// Fraction of the window past which clearing starts (0.6 when zero).
	Fraction float64
	// Keep is how many of the most recent tool results stay whole (5 when zero).
	Keep int
}

// DefaultKeep is how many recent tool calls keep their results.
const DefaultKeep = 5

// StubPrefix starts every stub.
const StubPrefix = "[cleared: "

// ClearObserver is implemented by a Sink that wants to know how many tool
// results a request had cleared.
type ClearObserver interface{ Cleared(n int) }

// estimateTokens is the harness's size estimate: four characters a token.
func estimateTokens(chars int) int64 { return int64((chars + 3) / 4) }

// Apply returns messages with old tool results cleared when the request
// (system, tools and messages) is estimated above the policy's share of the
// window, and how many results it cleared. Results already cleared stay cleared.
func (p ClearPolicy) Apply(systemChars, toolsChars int, messages []anthropic.MessageParam) ([]anthropic.MessageParam, int) {
	if p.WindowTokens <= 0 {
		return messages, 0
	}
	frac, keep := p.Fraction, p.Keep
	if frac <= 0 {
		frac = 0.6
	}
	if keep <= 0 {
		keep = DefaultKeep
	}
	raw, err := json.Marshal(messages)
	if err != nil {
		return messages, 0
	}
	if float64(estimateTokens(len(raw)+systemChars+toolsChars)) <= frac*float64(p.WindowTokens) {
		return messages, 0
	}
	var generic []map[string]any
	if json.Unmarshal(raw, &generic) != nil {
		return messages, 0
	}
	// Tool calls by id, and the order the results appear in.
	calls := map[string]map[string]any{}
	type pos struct{ m, b int }
	var results []pos
	for mi, m := range generic {
		blocks, _ := m["content"].([]any)
		for bi, b := range blocks {
			blk, _ := b.(map[string]any)
			switch blk["type"] {
			case "tool_use":
				if id, ok := blk["id"].(string); ok {
					calls[id] = blk
				}
			case "tool_result":
				results = append(results, pos{mi, bi})
			}
		}
	}
	if len(results) <= keep {
		return messages, 0
	}
	cleared := 0
	for _, r := range results[:len(results)-keep] {
		blk := generic[r.m]["content"].([]any)[r.b].(map[string]any)
		text := resultText(blk["content"])
		if strings.HasPrefix(text, StubPrefix) {
			continue
		}
		id, _ := blk["tool_use_id"].(string)
		blk["content"] = []any{map[string]any{"type": "text", "text": stub(calls[id], text)}}
		cleared++
	}
	if cleared == 0 {
		return messages, 0
	}
	out := make([]anthropic.MessageParam, len(messages))
	for i := range generic {
		b, err := json.Marshal(generic[i])
		if err != nil || json.Unmarshal(b, &out[i]) != nil {
			return messages, 0
		}
	}
	return out, cleared
}

func resultText(content any) string {
	switch c := content.(type) {
	case string:
		return c
	case []any:
		var b strings.Builder
		for _, x := range c {
			if m, ok := x.(map[string]any); ok {
				if t, ok := m["text"].(string); ok {
					b.WriteString(t)
				}
			}
		}
		return b.String()
	}
	return ""
}

// stub is "[cleared: read_file src/x.go, 412 lines]".
func stub(call map[string]any, text string) string {
	name, key := "tool", ""
	if call != nil {
		if n, ok := call["name"].(string); ok {
			name = n
		}
		if in, ok := call["input"].(map[string]any); ok {
			for _, k := range []string{"path", "command", "title", "query", "pattern", "task"} {
				if v, ok := in[k].(string); ok && v != "" {
					key = " " + oneLine(v, 60)
					break
				}
			}
		}
	}
	size := fmt.Sprintf("%d bytes", len(text))
	if n := strings.Count(text, "\n") + 1; n > 1 {
		size = fmt.Sprintf("%d lines", n)
	}
	return fmt.Sprintf("%s%s%s, %s]", StubPrefix, name, key, size)
}

func oneLine(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > n {
		return string(r[:n]) + "..."
	}
	return s
}
