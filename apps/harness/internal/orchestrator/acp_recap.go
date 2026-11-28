package orchestrator

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

const (
	// recapEntryCap is the baseline cap for an overly long single message when a
	// multi-message recap exceeds RecapCap, so one verbose assistant dump cannot
	// evict the rest of the conversation.
	recapEntryCap = 2000
	// recapOriginCap bounds the most recent dropped user request pinned at the
	// top when verbose assistant messages would otherwise push every user prompt
	// out of RecapCap.
	recapOriginCap = 400
)

type recapEntry struct {
	line          string
	isUserRequest bool
}

// hasUsableCompaction reports whether comp should replace messages up to its
// UptoMessageID when rebuilding history. An ACP agent (OpenCode) can record a
// non-cleared compaction row with no summary text; ignoring it prevents hiding
// earlier messages in the built-in loop and context/compact calculations.
func hasUsableCompaction(comp projectstore.Compaction, ok bool) bool {
	if !ok {
		return false
	}
	return comp.Cleared || strings.TrimSpace(comp.Summary) != ""
}

// recap summarizes the conversation before the current request for a session
// that has no memory of it: the latest compaction summary when the agent row
// has one (plus any messages stored after that compaction), otherwise the most
// recent user/assistant texts and answered request_input turns (at most
// recapMaxMessages of them), newest kept first, in order, and all within
// RecapCap bytes. Generic tool calls and results are left out.
func (rt *runtime) recap(ctx context.Context, agentID string, before []projectstore.Message) (string, error) {
	comp, ok, err := rt.db.LatestCompaction(ctx, agentID)
	if err != nil {
		return "", err
	}
	if len(before) == 0 && !(ok && comp.Cleared) {
		return "", nil
	}
	summary := ""
	recent := before
	if ok && strings.TrimSpace(comp.Summary) != "" {
		summary = strings.TrimSpace(comp.Summary)
		recent = messagesAfter(before, comp.UptoMessageID)
	}
	entries := buildRecapEntries(recent)
	if summary != "" && len(entries) == 0 {
		return clip(summary, RecapCap), nil
	}
	if summary == "" && len(entries) == 0 {
		return "", nil
	}
	if summary == "" {
		return packRecapEntries(entries, RecapCap, recapMaxMessages), nil
	}
	const sep = "\n\n"
	// Let unused budget flow in either direction: only split 50/50 when both
	// the summary and the post-compaction messages exceed half of RecapCap.
	tailHalf := RecapCap - min(len(summary), RecapCap/2) - len(sep)
	if tailHalf <= 0 {
		return clip(summary, RecapCap), nil
	}
	tail := packRecapEntries(entries, tailHalf, recapMaxMessages)
	if tail == "" {
		return clip(summary, RecapCap), nil
	}
	sumRoom := RecapCap - len(tail) - len(sep)
	if sumRoom <= 0 {
		return clip(summary, RecapCap), nil
	}
	sumPart := clip(summary, sumRoom)
	// If the summary needed less than half, allow tail to use the remaining room.
	if extraRoom := RecapCap - len(sumPart) - len(sep); extraRoom > tailHalf {
		tail = packRecapEntries(entries, extraRoom, recapMaxMessages)
	}
	return sumPart + sep + tail, nil
}

func messagesAfter(msgs []projectstore.Message, upto int64) []projectstore.Message {
	if upto <= 0 {
		return msgs
	}
	var out []projectstore.Message
	for _, m := range msgs {
		if m.ID > upto {
			out = append(out, m)
		}
	}
	return out
}

func isRequestInputToolName(name string) bool {
	if name == ToolRequestInput {
		return true
	}
	for _, sep := range []string{"_", ".", ":", "/"} {
		if strings.HasSuffix(name, sep+ToolRequestInput) {
			return true
		}
	}
	return false
}

func isRequestInputCall(b projectstore.ContentBlock) (string, bool) {
	if b.Type != "tool_use" || b.ID == nil || b.Name == nil {
		return "", false
	}
	if isRequestInputToolName(*b.Name) {
		return extractInputTitle(b.Input), true
	}
	// Unmapped ACP tool call wrapper: {"title": "<mcp name>", "raw_input": {"title": ...}}
	var wrap struct {
		Title    string          `json:"title"`
		RawInput json.RawMessage `json:"raw_input"`
	}
	if json.Unmarshal(b.Input, &wrap) == nil && len(wrap.RawInput) > 0 && isRequestInputToolName(strings.TrimSpace(wrap.Title)) {
		return extractInputTitle(b.Input), true
	}
	return "", false
}

func buildRecapEntries(msgs []projectstore.Message) []recapEntry {
	inputTitles := map[string]string{}
	for _, m := range msgs {
		if m.Role != "assistant" {
			continue
		}
		for _, b := range m.Content {
			if title, ok := isRequestInputCall(b); ok {
				inputTitles[*b.ID] = title
			}
		}
	}
	var out []recapEntry
	for _, m := range msgs {
		if text := messageText(m); text != "" {
			out = append(out, recapEntry{
				line:          m.Role + ": " + text,
				isUserRequest: m.Role == "user" && m.Command == "",
			})
			continue
		}
		if m.Role != "user" || len(inputTitles) == 0 {
			continue
		}
		for _, b := range m.Content {
			if b.Type != "tool_result" || b.ToolUseID == nil || b.Content == nil {
				continue
			}
			if b.IsError != nil && *b.IsError {
				continue
			}
			title, ok := inputTitles[*b.ToolUseID]
			if !ok {
				continue
			}
			if line := formatInputRecap(title, *b.Content); line != "" {
				out = append(out, recapEntry{line: line})
			}
		}
	}
	return out
}

func extractInputTitle(raw json.RawMessage) string {
	var in struct {
		Title    string          `json:"title"`
		Reason   string          `json:"reason"`
		RawInput json.RawMessage `json:"raw_input"`
	}
	if json.Unmarshal(raw, &in) != nil {
		return ""
	}
	// Prefer nested raw_input (wrapped ACP tool calls put the tool name in outer title).
	if len(in.RawInput) > 0 {
		var nested struct {
			Title  string `json:"title"`
			Reason string `json:"reason"`
		}
		if json.Unmarshal(in.RawInput, &nested) == nil {
			if t := strings.TrimSpace(nested.Title); t != "" {
				return t
			}
			if r := strings.TrimSpace(nested.Reason); r != "" {
				return oneLineOf(r, 80)
			}
		}
	}
	if t := strings.TrimSpace(in.Title); t != "" {
		return t
	}
	return oneLineOf(in.Reason, 80)
}

func formatInputRecap(title, raw string) string {
	raw = strings.TrimSpace(unfence(strings.TrimSpace(raw)))
	if raw == "" {
		return ""
	}
	var parsed struct {
		Status string            `json:"status"`
		Values map[string]any    `json:"values"`
		UseAs  map[string]string `json:"use_as"`
	}
	label := "user (input)"
	if title != "" {
		label = fmt.Sprintf("user (answered %q)", oneLineOf(title, 80))
	}
	if json.Unmarshal([]byte(raw), &parsed) == nil && parsed.Status != "" {
		switch parsed.Status {
		case "submitted":
			parts := make([]string, 0, len(parsed.Values)+len(parsed.UseAs))
			if len(parsed.Values) > 0 {
				keys := make([]string, 0, len(parsed.Values))
				for k := range parsed.Values {
					keys = append(keys, k)
				}
				slices.Sort(keys)
				for _, k := range keys {
					v := parsed.Values[k]
					switch x := v.(type) {
					case string:
						parts = append(parts, k+"="+oneLineOf(x, 120))
					default:
						b, err := json.Marshal(x)
						if err != nil {
							parts = append(parts, k+"="+oneLineOf(fmt.Sprint(x), 120))
						} else {
							parts = append(parts, k+"="+oneLineOf(string(b), 120))
						}
					}
				}
			}
			if len(parsed.UseAs) > 0 {
				keys := make([]string, 0, len(parsed.UseAs))
				for k := range parsed.UseAs {
					keys = append(keys, k)
				}
				slices.Sort(keys)
				for _, k := range keys {
					if handle := strings.TrimSpace(parsed.UseAs[k]); handle != "" {
						parts = append(parts, k+"="+oneLineOf(handle, 80))
					}
				}
			}
			if len(parts) == 0 {
				return label + ": submitted"
			}
			return label + ": " + strings.Join(parts, ", ")
		case "skipped":
			return label + ": skipped"
		default:
			return ""
		}
	}
	return label + ": " + oneLineOf(raw, 200)
}

func packRecapEntries(entries []recapEntry, capBytes, maxLines int) string {
	if len(entries) == 0 || capBytes <= 0 || maxLines <= 0 {
		return ""
	}
	// If everything fits unmodified within both limits, keep it verbatim.
	if len(entries) <= maxLines {
		total := 0
		for i, e := range entries {
			if i > 0 {
				total++
			}
			total += len(e.line)
		}
		if total <= capBytes {
			lines := make([]string, len(entries))
			for i, e := range entries {
				lines[i] = e.line
			}
			return strings.Join(lines, "\n")
		}
	}

	// Only bound the tail window collectRecapSuffix can visit, using a dynamic
	// floor so short conversations (e.g. 2 messages) still use the full budget
	// while verbose multi-message turns cannot let one entry evict the rest.
	winStart := max(0, len(entries)-maxLines)
	tail := entries[winStart:]
	perCap := min(capBytes, max(recapEntryCap, capBytes/max(len(tail), 1)))
	bounded := make([]recapEntry, len(tail))
	for i, e := range tail {
		line := e.line
		if len(line) > perCap {
			line = clipMiddle(line, perCap)
		}
		bounded[i] = recapEntry{line: line, isUserRequest: e.isUserRequest}
	}

	kept, oldestRel, hasUser := collectRecapSuffix(bounded, capBytes, maxLines)
	oldestIdx := winStart + oldestRel
	// If verbose assistant messages pushed out every user request, pin the
	// most recent dropped user request at the top so the agent knows what
	// task the conversation is about.
	if !hasUser && oldestIdx > 0 && maxLines >= 2 {
		pinIdx := -1
		for i := oldestIdx - 1; i >= 0; i-- {
			if entries[i].isUserRequest {
				pinIdx = i
				break
			}
		}
		if pinIdx >= 0 {
			pinLimit := min(recapOriginCap, capBytes/4)
			pinLine := clip(entries[pinIdx].line, pinLimit)
			if pinLine != "" {
				if room := capBytes - len(pinLine) - 1; room > 0 {
					afterPin := bounded
					if pinIdx >= winStart {
						afterPin = bounded[pinIdx-winStart+1:]
					}
					suffix, _, _ := collectRecapSuffix(afterPin, room, maxLines-1)
					if len(suffix) > 0 {
						return strings.Join(append([]string{pinLine}, suffix...), "\n")
					}
				}
			}
		}
	}
	return strings.Join(kept, "\n")
}

func collectRecapSuffix(entries []recapEntry, capBytes, maxLines int) (lines []string, oldestIdx int, hasUser bool) {
	used := 0
	oldestIdx = len(entries)
	for i := len(entries) - 1; i >= 0 && len(lines) < maxLines; i-- {
		line := entries[i].line
		sep := 0
		if len(lines) > 0 {
			sep = 1
		}
		room := capBytes - used - sep
		if room <= 0 {
			break
		}
		if len(line) > room {
			// If we already have newer lines and the remaining sliver is too
			// tiny to be useful, stop rather than prepending a stub.
			if len(lines) > 0 && room < 40 {
				break
			}
			line = clipMiddle(line, room)
		}
		used += len(line) + sep
		lines = append(lines, line)
		oldestIdx = i
		if entries[i].isUserRequest {
			hasUser = true
		}
	}
	slices.Reverse(lines)
	return lines, oldestIdx, hasUser
}

// clip shortens s to at most n bytes at a rune boundary, marking the cut.
func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	const mark = "...(cut)"
	if n <= len(mark) {
		return trimValidUTF8Prefix(s, n)
	}
	return trimValidUTF8Prefix(s, n-len(mark)) + mark
}

// clipMiddle shortens s to at most n bytes by keeping its start and end (more
// weight on the end, where recent progress lives) separated by a cut marker.
func clipMiddle(s string, n int) string {
	if len(s) <= n {
		return s
	}
	const mark = "...(cut)..."
	if n <= len(mark)+4 {
		return clip(s, n)
	}
	avail := n - len(mark)
	headCap := avail / 3
	tailCap := avail - headCap
	head := trimValidUTF8Prefix(s, headCap)
	tail := trimValidUTF8Suffix(s, tailCap)
	return head + mark + tail
}

func trimValidUTF8Prefix(s string, maxBytes int) string {
	if maxBytes <= 0 {
		return ""
	}
	if len(s) <= maxBytes {
		return strings.ToValidUTF8(s, "")
	}
	cut := maxBytes
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return strings.ToValidUTF8(s[:cut], "")
}

func trimValidUTF8Suffix(s string, maxBytes int) string {
	if maxBytes <= 0 {
		return ""
	}
	if len(s) <= maxBytes {
		return strings.ToValidUTF8(s, "")
	}
	start := len(s) - maxBytes
	for start < len(s) && !utf8.RuneStart(s[start]) {
		start++
	}
	return strings.ToValidUTF8(s[start:], "")
}
