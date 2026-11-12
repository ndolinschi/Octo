package fakeacp

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// defaultSessionID is the session id unless EnvUniqueSessions asks for fresh ones.
const defaultSessionID = "fake-session-1"

// Markers in the prompt text that switch the scripted behaviour.
const (
	MarkerEscape  = "[escape]"
	MarkerCrash   = "[crash]"
	MarkerHang    = "[hang]"
	MarkerDeaf    = "[deaf]"
	MarkerUnknown = "[unknown]"
	// MarkerMCPSpawn drives the harness MCP server: list tools, ask permission,
	// call spawn_agent (on the first external agent the schema offers), then
	// save_note, and report pid, session and transport.
	MarkerMCPSpawn = "[mcp-spawn]"
	// MarkerMCPSpawnBuiltin is MarkerMCPSpawn but asks for a built-in sub-agent
	// (no `agent` argument), the one that needs the Messages API.
	MarkerMCPSpawnBuiltin = "[mcp-spawn-builtin]"
	// MarkerEcho makes the agent answer with pid, session and the prompt it got.
	MarkerEcho = "[echo]"
	// MarkerMCPInfo reports the MCP server entry the client gave (url and
	// bearer token), so a test can speak to the endpoint as the agent would.
	MarkerMCPInfo = "[mcp-info]"
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
	if err := a.notify("session/update", map[string]any{"sessionId": a.sid(), "update": u}); err != nil {
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
	// Markers count only in the user's request: the harness may put a recap of
	// earlier requests (which hold other markers) before "User request:".
	request := prompt
	if i := strings.LastIndex(prompt, "User request:\n"); i >= 0 {
		request = prompt[i+len("User request:\n"):]
	}
	a.mu.Lock()
	cwd := a.cwd
	a.deafMode = strings.Contains(request, MarkerDeaf)
	a.mu.Unlock()
	has := func(m string) bool { return strings.Contains(request, m) }

	switch {
	case has(MarkerSilent):
		return "end_turn" // says nothing, calls nothing: what a CLI that is not logged in can do
	case has(MarkerRefuse):
		return "refusal"
	case has(MarkerMaxTokens):
		return "max_tokens"
	case has(MarkerLive) || has(MarkerSlowTool) || has(MarkerQuiet) || has(MarkerSecretThought) || has(MarkerAuthRequired) || has(MarkerLateInput) || has(MarkerSayHang):
		stop, _ := a.liveScript(ctx, cwd, request)
		return stop
	}
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
	case has(MarkerCumCost):
		return a.cumCost()
	case has(MarkerOwnEdit):
		return a.ownEdit(cwd)
	case has(MarkerPerm):
		return a.permScript(ctx, cwd)
	case has(MarkerMode):
		a.mu.Lock()
		cur := a.mode
		a.mu.Unlock()
		a.say("mode=" + cur)
		return "end_turn"
	case has(MarkerWrite):
		_, rpcErr, err := a.call(ctx, "fs/write_text_file", map[string]any{"sessionId": a.sid(), "path": filepath.Join(cwd, WriteFile), "content": "written\n"})
		switch {
		case err != nil:
			return "cancelled"
		case rpcErr != nil:
			a.say("fswrite refused: " + rpcErr.Message)
		default:
			a.say("fswrite ok")
		}
		return "end_turn"
	case has(MarkerAskForm):
		return a.askForm(ctx)
	case has(MarkerLeakEnv):
		return a.leakEnv()
	case has(MarkerEcho):
		a.mu.Lock()
		loaded := a.loaded
		a.mu.Unlock()
		a.say(fmt.Sprintf("pid=%d session=%s loaded=%v prompt<<%s>>", os.Getpid(), a.sid(), loaded, prompt))
		return "end_turn"
	case has(MarkerMCPSpawnBuiltin):
		return a.mcpSpawn(ctx, true)
	case has(MarkerMCPSpawn):
		return a.mcpSpawn(ctx, false)
	case has(MarkerMCPInfo):
		a.say(a.mcpInfo())
		return "end_turn"
	}
	extra := ""
	if has(MarkerUnknown) {
		a.update(map[string]any{"sessionUpdate": "future_variant_v99", "payload": map[string]any{"x": 1}})
		_, rpcErr, err := a.call(ctx, "x/unknown_method", map[string]string{"sessionId": a.sid()})
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
	if res, rpcErr, err := a.call(ctx, "fs/read_text_file", map[string]any{"sessionId": a.sid(), "path": readme}); err != nil {
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
	_, rpcErr, err := a.call(ctx, "fs/write_text_file", map[string]any{"sessionId": a.sid(), "path": note, "content": noteBody})
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
	extra += a.envReport()
	a.say("Summary: " + summary + "; I wrote " + NoteFile + " with a short note." + extra)
	return "end_turn"
}

func (a *agent) escape(ctx context.Context) string {
	a.toolCall("call-escape", "Read /etc/hostname", "read", "pending", "/etc/hostname")
	_, rpcErr, err := a.call(ctx, "fs/read_text_file", map[string]any{"sessionId": a.sid(), "path": "/etc/hostname"})
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
		"sessionId": a.sid(),
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

// mcpToolCall announces a tool call that is not a file operation.
func (a *agent) mcpToolCall(id, title string, args map[string]any) {
	a.update(map[string]any{
		"sessionUpdate": "tool_call", "toolCallId": id, "title": title, "kind": "other", "status": "in_progress",
		"rawInput": args,
	})
}

// mcpSpawn is the [mcp-spawn] script.
func (a *agent) mcpSpawn(ctx context.Context, builtin bool) string {
	a.say("Using the harness tools. ")
	c, err := a.harnessMCP(ctx)
	if err != nil {
		a.say("No harness tools: " + err.Error() + ". ")
		a.say(a.identity())
		return "end_turn"
	}
	tools, err := c.tools(ctx)
	if err != nil {
		a.say("tools/list failed: " + err.Error())
		return "end_turn"
	}
	names := make([]string, len(tools))
	spawnAgent, autoTier := "", false
	for i, t := range tools {
		names[i] = t.Name
		if t.Name == "spawn_agent" {
			autoTier = slices.Contains(t.InputSchema.Properties["tier"].Enum, "auto")
			if enum := t.InputSchema.Properties["agent"].Enum; len(enum) > 0 {
				spawnAgent = enum[0]
			}
		}
	}
	a.say("Tools: " + strings.Join(names, ",") + ". ")

	args := map[string]any{"role": "Explorer", "title": "Look around", "task": "Report that you are ready.", "tier": "fast"}
	if autoTier {
		// The schema offers tier auto (a router can choose): leave the choice to it.
		args["tier"] = "auto"
	} else if spawnAgent != "" && !builtin {
		args["agent"] = spawnAgent
	}
	a.mcpToolCall("mcp-spawn-1", mcpTitle("spawn_agent"), args)
	granted, ok := a.askPermission(ctx, "mcp-spawn-1", mcpTitle("spawn_agent"))
	if !ok {
		return "cancelled"
	}
	if granted != "allow-once" {
		a.toolUpdate("mcp-spawn-1", "failed", textContent("permission denied: "+granted))
		a.say("Permission was not granted. ")
		return "end_turn"
	}
	report, isErr, err := c.callTool(ctx, "spawn_agent", args)
	switch {
	case err != nil:
		if ctx.Err() != nil {
			return "cancelled"
		}
		a.toolUpdate("mcp-spawn-1", "failed", textContent(err.Error()))
		a.say("spawn_agent failed: " + err.Error() + ". ")
	case isErr:
		a.toolUpdate("mcp-spawn-1", "failed", textContent(report))
		a.say("spawn_agent returned an error: " + report + ". ")
	default:
		a.toolUpdate("mcp-spawn-1", "completed", textContent(report))
		a.say("Sub-agent report: " + report + ". ")
	}

	noteArgs := map[string]any{"title": "mcp-note", "content": "written via MCP"}
	a.mcpToolCall("mcp-note-1", mcpTitle("save_note"), noteArgs)
	text, isErr, err := c.callTool(ctx, "save_note", noteArgs)
	if err != nil || isErr {
		a.toolUpdate("mcp-note-1", "failed", textContent(fmt.Sprint(text, err)))
		a.say("save_note failed. ")
	} else {
		a.toolUpdate("mcp-note-1", "completed", textContent(text))
		a.say("Note saved. ")
	}
	a.usageUpdate(900, 0.004, "USD")
	a.say(a.identity())
	return "end_turn"
}

// mcpInfo describes the first MCP server entry: its endpoint and bearer token.
func (a *agent) mcpInfo() string {
	a.mu.Lock()
	servers := a.mcpSrvs
	a.mu.Unlock()
	if len(servers) == 0 {
		return "mcp-info: none"
	}
	e := servers[0]
	if e.Type == "http" {
		tok := ""
		for _, h := range e.Headers {
			if strings.EqualFold(h.Name, "Authorization") {
				tok = strings.TrimPrefix(h.Value, "Bearer ")
			}
		}
		return fmt.Sprintf("mcp-info: transport=http url=%s token=%s", e.URL, tok)
	}
	url, tok := "", ""
	for i, arg := range e.Args {
		if arg == "--url" && i+1 < len(e.Args) {
			url = e.Args[i+1]
		}
	}
	for _, kv := range e.Env {
		tok = kv.Value
	}
	return fmt.Sprintf("mcp-info: transport=stdio url=%s token=%s argv=%q", url, tok, e.Args)
}

// identity says which process and session answered, and over which MCP transport.
func (a *agent) identity() string {
	a.mu.Lock()
	loaded, c := a.loaded, a.mcpc
	a.mu.Unlock()
	transport, relay := "none", 0
	if c != nil {
		transport, relay = c.transport, c.relayPID
	}
	return fmt.Sprintf("pid=%d session=%s loaded=%v mcp=%s relay=%d", os.Getpid(), a.sid(), loaded, transport, relay)
}
