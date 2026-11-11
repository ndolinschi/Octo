package fakeacp

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Markers for the v7 flows (changes, approvals, forms).
const (
	// MarkerOwnEdit makes the agent edit files with its own tools, directly on
	// disk and without any fs/* request: it creates OwnEditFile and rewrites
	// README.md.
	MarkerOwnEdit = "[own-edit]"
	// MarkerPerm asks permission for a shell command (the four option kinds,
	// with a command and a location), reports the option the client chose and,
	// when it was an allow, runs the "command" (creates PermFile on disk).
	MarkerPerm = "[perm]"
	// MarkerAskForm calls the harness tool request_input (an API key and a
	// region) and reports the result.
	MarkerAskForm = "[ask-form]"
	// MarkerLeakEnv says the value of the variable named by OCTO_FAKEACP_LEAK_ENV
	// in an agent message (a careless agent: the harness must not store it).
	MarkerLeakEnv = "[leak-env]"
)

// Markers for the failure paths: the turn ends without text or tool calls
// (MarkerSilent), or with stopReason refusal / max_tokens.
const (
	MarkerSilent    = "[silent]"
	MarkerRefuse    = "[refuse]"
	MarkerMaxTokens = "[max-tokens]"
)

// MarkerCumCost makes the agent report a session-wide cumulative usage: each
// prompt adds 0.01 USD and 100 tokens to counters that live as long as the
// process, the way real agents report.
const MarkerCumCost = "[cum-cost]"

// EnvMCPTitle is the title template (one %s: the harness tool's name) of the
// tool_call rows the agent announces for its MCP calls; default "octo-harness: %s".
// Real agents use shapes such as "mcp__octo-harness__%s".
const EnvMCPTitle = "OCTO_FAKEACP_MCP_TITLE"

func mcpTitle(tool string) string {
	t := os.Getenv(EnvMCPTitle)
	if t == "" {
		t = "octo-harness: %s"
	}
	return fmt.Sprintf(t, tool)
}

// OwnEditFile is the file MarkerOwnEdit creates in the session cwd.
const OwnEditFile = "own-edit.txt"

// PermFile is the file MarkerPerm creates after an allow.
const PermFile = "perm-ran.txt"

// EnvLeakEnv names the variable MarkerLeakEnv reports.
const EnvLeakEnv = "OCTO_FAKEACP_LEAK_ENV"

func (a *agent) ownEdit(cwd string) string {
	a.say("Editing with my own tools. ")
	a.toolCall("call-own", "Edit files", "edit", "in_progress", filepath.Join(cwd, OwnEditFile))
	err1 := os.WriteFile(filepath.Join(cwd, OwnEditFile), []byte("own one\nown two\n"), 0o644)
	err2 := os.WriteFile(filepath.Join(cwd, "README.md"), []byte("# rewritten by the agent\n"), 0o644)
	a.toolUpdate("call-own", "completed", textContent(fmt.Sprint("done ", err1, err2)))
	a.say("Done editing.")
	return "end_turn"
}

func (a *agent) permScript(ctx context.Context, cwd string) string {
	a.update(map[string]any{
		"sessionUpdate": "tool_call", "toolCallId": "call-perm", "title": "Run npm test", "kind": "execute", "status": "pending",
		"locations": []map[string]string{{"path": filepath.Join(cwd, "package.json")}},
		"rawInput":  map[string]string{"command": "npm test"},
	})
	res, rpcErr, err := a.call(ctx, "session/request_permission", map[string]any{
		"sessionId": a.sid(),
		"toolCall": map[string]any{
			"toolCallId": "call-perm", "title": "Run npm test", "kind": "execute",
			"locations": []map[string]string{{"path": filepath.Join(cwd, "package.json")}},
			"rawInput":  map[string]string{"command": "npm test"},
		},
		"options": []map[string]string{
			{"optionId": "p-allow-once", "name": "Allow once", "kind": "allow_once"},
			{"optionId": "p-allow-always", "name": "Always allow", "kind": "allow_always"},
			{"optionId": "p-reject-once", "name": "Reject once", "kind": "reject_once"},
			{"optionId": "p-reject-always", "name": "Always reject", "kind": "reject_always"},
		},
	})
	if err != nil || rpcErr != nil {
		return "cancelled"
	}
	var out struct {
		Outcome struct{ Outcome, OptionID string }
	}
	if err := json.Unmarshal(res, &out); err != nil {
		return "cancelled"
	}
	if out.Outcome.Outcome != "selected" {
		a.toolUpdate("call-perm", "failed", textContent("cancelled"))
		a.say("permission outcome=" + out.Outcome.Outcome)
		return "end_turn"
	}
	chosen := out.Outcome.OptionID
	if strings.HasPrefix(chosen, "p-allow") {
		_ = os.WriteFile(filepath.Join(cwd, PermFile), []byte("ran\n"), 0o644)
		a.toolUpdate("call-perm", "completed", textContent("tests passed"))
	} else {
		a.toolUpdate("call-perm", "failed", textContent("rejected"))
	}
	a.say("permission chosen=" + chosen)
	return "end_turn"
}

func (a *agent) askForm(ctx context.Context) string {
	c, err := a.harnessMCP(ctx)
	if err != nil {
		a.say("No harness tools: " + err.Error())
		return "end_turn"
	}
	args := map[string]any{
		"title": "Credentials", "reason": "Needed to call the service.",
		"fields": []map[string]any{
			{"id": "api_key", "label": "API key", "kind": "secret", "required": true},
			{"id": "region", "label": "Region", "kind": "text"},
		},
	}
	a.mcpToolCall("mcp-form-1", mcpTitle("request_input"), args)
	text, isErr, err := c.callTool(ctx, "request_input", args)
	switch {
	case err != nil:
		if ctx.Err() != nil {
			return "cancelled"
		}
		a.toolUpdate("mcp-form-1", "failed", textContent(err.Error()))
		a.say("request_input failed: " + err.Error())
	case isErr:
		a.toolUpdate("mcp-form-1", "failed", textContent(text))
		a.say("request_input error: " + text)
	default:
		a.toolUpdate("mcp-form-1", "completed", textContent(text))
		a.say("Form result: " + text)
	}
	return "end_turn"
}

func (a *agent) leakEnv() string {
	name := os.Getenv(EnvLeakEnv)
	a.say(fmt.Sprintf("%s=%s", name, os.Getenv(name)))
	return "end_turn"
}

func (a *agent) cumCost() string {
	a.mu.Lock()
	a.cumN++
	n := a.cumN
	a.mu.Unlock()
	a.say("counting. ")
	a.usageUpdate(1000+100*n, 0.01*float64(n), "USD")
	return "end_turn"
}
