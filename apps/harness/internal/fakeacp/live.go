package fakeacp

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"time"
)

// Markers for the live-activity flows (decision 55): what an agent does before
// and while it writes.
const (
	// MarkerLive plays a typical Claude Code turn: a thought (its first chunk
	// carries the send time in nanoseconds, "t=<ns>;"), the commands/mode
	// updates agents send unasked, a plan, a read tool call announced, updated
	// (title, in_progress) and completed 150 ms later, a second thought, a plan
	// with a step ticked off, then 20 text chunks 20 ms apart ("<ns>;c01 ", each
	// carrying its send time).
	MarkerLive = "[live]"
	// MarkerSlowTool announces a shell tool call, stays in_progress for 400 ms
	// without a word, completes it and then answers.
	MarkerSlowTool = "[slow-tool]"
	// MarkerQuiet thinks once and then sends nothing at all for 600 ms before
	// answering.
	MarkerQuiet = "[quiet]"
	// MarkerLateInput announces a tool call with no input and sends the input
	// (and a better title) in a tool_call_update, as real agents do.
	MarkerLateInput = "[late-input]"
	// MarkerSayHang writes some text and then waits to be cancelled.
	MarkerSayHang = "[say-hang]"
	// MarkerAuthRequired answers session/prompt with the JSON-RPC error -32000
	// "Authentication required", as an agent whose login expired does.
	MarkerAuthRequired = "[auth-required]"
	// MarkerSecretThought is followed by a secret value ("[secret-thought:VALUE]"):
	// the value is split across two thought chunks and put in a plan entry, as
	// an agent that echoes what it was told would.
	MarkerSecretThought = "[secret-thought:"
)

// stopAuthRequired is the pseudo stop reason that makes the prompt fail with an RPC error.
const stopAuthRequired = "<auth-required>"

func (a *agent) pause(ctx context.Context, d time.Duration) bool {
	select {
	case <-ctx.Done():
		return false
	case <-time.After(d):
		return true
	}
}

func (a *agent) think(text string) {
	a.update(map[string]any{"sessionUpdate": "agent_thought_chunk", "content": textBlock(text)})
}

func (a *agent) plan(entries ...[3]string) {
	list := make([]map[string]string, 0, len(entries))
	for _, e := range entries {
		list = append(list, map[string]string{"content": e[0], "status": e[1], "priority": e[2]})
	}
	a.update(map[string]any{"sessionUpdate": "plan", "entries": list})
}

// liveScript dispatches the live-activity markers; ok is false when the
// request has none of them.
func (a *agent) liveScript(ctx context.Context, cwd, request string) (stop string, ok bool) {
	has := func(m string) bool { return strings.Contains(request, m) }
	switch {
	case has(MarkerLive):
		return a.live(ctx, cwd), true
	case has(MarkerSlowTool):
		a.toolCall("call-slow", "pnpm test", "execute", "in_progress", cwd)
		if !a.pause(ctx, 400*time.Millisecond) {
			return "cancelled", true
		}
		a.toolUpdate("call-slow", "completed", textContent("all passed"))
		a.say("Tests passed.")
		return "end_turn", true
	case has(MarkerQuiet):
		a.think("Thinking about it. ")
		if !a.pause(ctx, 600*time.Millisecond) {
			return "cancelled", true
		}
		a.say("Done thinking.")
		return "end_turn", true
	case has(MarkerLateInput):
		a.update(map[string]any{"sessionUpdate": "tool_call", "toolCallId": "call-late", "title": "Tool", "kind": "other", "status": "pending"})
		a.update(map[string]any{
			"sessionUpdate": "tool_call_update", "toolCallId": "call-late", "status": "in_progress", "title": "Review the change",
			"rawInput": map[string]string{"task": "check the diff", "tier": "fast"},
		})
		a.toolUpdate("call-late", "completed", textContent("looks fine"))
		a.say("Reviewed.")
		return "end_turn", true
	case has(MarkerSayHang):
		a.say("Working on it, first the ")
		<-ctx.Done()
		return "cancelled", true
	case has(MarkerAuthRequired):
		return stopAuthRequired, true
	case has(MarkerSecretThought):
		i := strings.Index(request, MarkerSecretThought) + len(MarkerSecretThought)
		secret, _, _ := strings.Cut(request[i:], "]")
		half := len(secret) / 2
		a.think("The key is " + secret[:half])
		a.think(secret[half:] + " and I will not repeat it. ")
		a.plan([3]string{"Use " + secret + " carefully", "pending", "high"})
		a.say("Noted.")
		return "end_turn", true
	}
	return "", false
}

func (a *agent) live(ctx context.Context, cwd string) string {
	a.think(fmt.Sprintf("t=%d;Let me look at the project. ", time.Now().UnixNano()))
	a.update(map[string]any{"sessionUpdate": "available_commands_update", "availableCommands": []map[string]string{{"name": "init", "description": "x"}}})
	a.update(map[string]any{"sessionUpdate": "current_mode_update", "currentModeId": "code"})
	a.plan([3]string{"Read the README", "in_progress", "high"}, [3]string{"Summarise it", "pending", "medium"})
	readme := filepath.Join(cwd, "README.md")
	a.toolCall("call-live", "Read file", "read", "pending", readme)
	a.update(map[string]any{
		"sessionUpdate": "tool_call_update", "toolCallId": "call-live", "status": "in_progress",
		"title": "Read README.md", "locations": []map[string]string{{"path": readme}},
	})
	if !a.pause(ctx, 150*time.Millisecond) {
		return "cancelled"
	}
	a.toolUpdate("call-live", "completed", textContent("read 12 bytes"))
	a.think("Now I can answer. ")
	a.plan([3]string{"Read the README", "completed", "high"}, [3]string{"Summarise it", "in_progress", "medium"})
	for i := 1; i <= 20; i++ {
		a.say(fmt.Sprintf("%d;c%02d ", time.Now().UnixNano(), i))
		if !a.pause(ctx, 20*time.Millisecond) {
			return "cancelled"
		}
	}
	return "end_turn"
}
