package fakeacp

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const sessionID = "fake-session-1"

// Markers in the prompt text that switch the scripted behaviour.
const (
	MarkerEscape  = "[escape]"
	MarkerCrash   = "[crash]"
	MarkerHang    = "[hang]"
	MarkerDeaf    = "[deaf]"
	MarkerUnknown = "[unknown]"
	// MarkerNonUSD makes the usage_update costs use EUR instead of USD.
	MarkerNonUSD = "[eur]"
)

// Cumulative session costs the default script reports in its usage_updates.
const (
	CostAfterRead = 0.012
	CostAfterEdit = 0.03
)

// usageUpdate reports context occupancy and a cumulative cost.
func (a *agent) usageUpdate(used int, cost float64, currency string) {
	a.update(map[string]any{
		"sessionUpdate": "usage_update", "used": used, "size": 200000,
		"cost": map[string]any{"amount": cost, "currency": currency},
	})
}

// NoteFile is the file the default script writes into the session cwd.
const NoteFile = "acp-demo-note.md"

const noteBody = "# ACP demo note\n\nWritten by the fake ACP agent through fs/write_text_file.\n"

// deaf is set for the [deaf] marker: session/cancel is then ignored.
func (a *agent) deaf() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.deafMode
}

func (a *agent) say(text string) {
	a.update(map[string]any{"sessionUpdate": "agent_message_chunk", "content": textBlock(text)})
}

func textBlock(text string) map[string]string { return map[string]string{"type": "text", "text": text} }

func (a *agent) update(u map[string]any) {
	if err := a.notify("session/update", map[string]any{"sessionId": sessionID, "update": u}); err != nil {
		fmt.Fprintln(a.log, "update:", err)
	}
}

func (a *agent) toolCall(id, title, kind, status, path string) {
	a.update(map[string]any{
		"sessionUpdate": "tool_call", "toolCallId": id, "title": title, "kind": kind, "status": status,
		"locations": []map[string]string{{"path": path}}, "rawInput": map[string]string{"path": path},
	})
}

func (a *agent) toolUpdate(id, status string, content ...any) {
	u := map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": id, "status": status}
	if len(content) > 0 {
		u["content"] = content
	}
	a.update(u)
}

func textContent(text string) map[string]any {
	return map[string]any{"type": "content", "content": textBlock(text)}
}

// runScript plays the scripted turn and returns the stop reason.
func (a *agent) runScript(ctx context.Context, prompt string) string {
	a.mu.Lock()
	cwd := a.cwd
	a.deafMode = strings.Contains(prompt, MarkerDeaf)
	a.mu.Unlock()
	has := func(m string) bool { return strings.Contains(prompt, m) }

	a.say("I'll look at the project first. ")
	switch {
	case has(MarkerCrash):
		a.toolCall("call-crash", "Read README.md", "read", "pending", filepath.Join(cwd, "README.md"))
		a.exit(3)
		return "end_turn"
	case has(MarkerHang) || has(MarkerDeaf):
		a.update(map[string]any{
			"sessionUpdate": "tool_call", "toolCallId": "call-hang", "title": "Waiting forever", "kind": "other",
			"status": "in_progress", "rawInput": map[string]int{"pid": os.Getpid()},
		})
		<-ctx.Done()
		return "cancelled"
	case has(MarkerEscape):
		return a.escape(ctx)
	}
	extra := ""
	if has(MarkerUnknown) {
		a.update(map[string]any{"sessionUpdate": "future_variant_v99", "payload": map[string]any{"x": 1}})
		_, rpcErr, err := a.call(ctx, "x/unknown_method", map[string]string{"sessionId": sessionID})
		switch {
		case err != nil:
			return "cancelled"
		case rpcErr != nil:
			extra = fmt.Sprintf(" Unknown request answered with error %d.", rpcErr.Code)
		default:
			extra = " Unknown request unexpectedly succeeded."
		}
	}
	currency := "USD"
	if has(MarkerNonUSD) {
		currency = "EUR"
	}
	return a.defaultScript(ctx, cwd, extra, currency)
}

func (a *agent) defaultScript(ctx context.Context, cwd, extra, currency string) string {
	a.say("Reading the README. ")
	readme := filepath.Join(cwd, "README.md")
	a.toolCall("call-read", "Read README.md", "read", "pending", readme)
	a.toolUpdate("call-read", "in_progress")
	summary := "README.md could not be read"
	if res, rpcErr, err := a.call(ctx, "fs/read_text_file", map[string]any{"sessionId": sessionID, "path": readme}); err != nil {
		return "cancelled"
	} else if rpcErr != nil {
		a.toolUpdate("call-read", "failed", textContent(rpcErr.Message))
		summary += ": " + rpcErr.Message
	} else {
		var r struct{ Content string }
		if err := json.Unmarshal(res, &r); err != nil {
			fmt.Fprintln(a.log, "bad read result:", err)
		}
		first, _, _ := strings.Cut(strings.TrimSpace(r.Content), "\n")
		summary = fmt.Sprintf("README.md has %d bytes and starts with %q", len(r.Content), first)
		a.toolUpdate("call-read", "completed", textContent(fmt.Sprintf("read %d bytes", len(r.Content))))
	}
	a.usageUpdate(1200, CostAfterRead, currency)

	a.say("Now I'll record a note. ")
	note := filepath.Join(cwd, NoteFile)
	a.toolCall("call-edit", "Write "+NoteFile, "edit", "pending", note)
	granted, ok := a.askPermission(ctx, "call-edit", "Write "+NoteFile)
	if !ok {
		return "cancelled"
	}
	if granted != "allow-once" {
		a.toolUpdate("call-edit", "failed", textContent("permission denied: "+granted))
		a.say("Permission was not granted. ")
		return "end_turn"
	}
	_, rpcErr, err := a.call(ctx, "fs/write_text_file", map[string]any{"sessionId": sessionID, "path": note, "content": noteBody})
	switch {
	case err != nil:
		return "cancelled"
	case rpcErr != nil:
		a.toolUpdate("call-edit", "failed", textContent(rpcErr.Message))
		a.say("Writing the note failed: " + rpcErr.Message)
		return "end_turn"
	}
	a.toolUpdate("call-edit", "completed", map[string]any{"type": "diff", "path": note, "oldText": nil, "newText": noteBody})
	a.usageUpdate(1800, CostAfterEdit, currency)
	if model := a.currentModel(); model != "" {
		extra += " Model in use: " + model + "."
	}
	a.say("Summary: " + summary + "; I wrote " + NoteFile + " with a short note." + extra)
	return "end_turn"
}

func (a *agent) escape(ctx context.Context) string {
	a.toolCall("call-escape", "Read /etc/hostname", "read", "pending", "/etc/hostname")
	_, rpcErr, err := a.call(ctx, "fs/read_text_file", map[string]any{"sessionId": sessionID, "path": "/etc/hostname"})
	switch {
	case err != nil:
		return "cancelled"
	case rpcErr == nil:
		a.toolUpdate("call-escape", "completed", textContent("read succeeded"))
		a.say("Escape attempt NOT refused: /etc/hostname was readable.")
	default:
		a.toolUpdate("call-escape", "failed", textContent(rpcErr.Message))
		a.say("Escape attempt refused: " + rpcErr.Message)
	}
	return "end_turn"
}

// askPermission requests permission for a tool call. The options are ordered
// so that only a client picking the first allow_once ends up with "allow-once".
func (a *agent) askPermission(ctx context.Context, toolID, title string) (string, bool) {
	res, rpcErr, err := a.call(ctx, "session/request_permission", map[string]any{
		"sessionId": sessionID,
		"toolCall":  map[string]any{"toolCallId": toolID, "title": title},
		"options": []map[string]string{
			{"optionId": "reject-once", "name": "Reject", "kind": "reject_once"},
			{"optionId": "allow-always", "name": "Always allow", "kind": "allow_always"},
			{"optionId": "allow-once", "name": "Allow", "kind": "allow_once"},
		},
	})
	if err != nil || rpcErr != nil {
		return "", false
	}
	var out struct {
		Outcome struct{ Outcome, OptionID string }
	}
	if err := json.Unmarshal(res, &out); err != nil || out.Outcome.Outcome != "selected" {
		return "", false
	}
	return out.Outcome.OptionID, true
}
