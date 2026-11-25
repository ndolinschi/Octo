package fakeacp

import (
	"context"
	"encoding/json"
	"strings"
)

// lazyTask is the brief the lazy scripts delegate.
const lazyTask = "Report that you are ready."

// exampleArgs finds the JSON object after "Example arguments: " in text and
// returns its keys filled with this agent's own values (role, title, task) or
// the example's (tier...). nil when text shows no example.
func exampleArgs(text string) map[string]any {
	const mark = "Example arguments: "
	i := strings.Index(text, mark)
	if i < 0 {
		return nil
	}
	var ex map[string]any
	if err := json.NewDecoder(strings.NewReader(text[i+len(mark):])).Decode(&ex); err != nil {
		return nil
	}
	own := map[string]any{"role": "Explorer", "title": "Look around", "task": lazyTask}
	for k := range ex {
		if v, ok := own[k]; ok {
			ex[k] = v
		}
	}
	return ex
}

// mcpSpawnLazy is the [mcp-spawn-lazy] / [mcp-spawn-guess] script.
func (a *agent) mcpSpawnLazy(ctx context.Context, useInstructions bool) string {
	c, err := a.harnessMCP(ctx)
	if err != nil {
		a.say("No harness tools: " + err.Error())
		return "end_turn"
	}
	a.mu.Lock()
	instr := a.mcpInstr
	a.mu.Unlock()
	args := map[string]any{"task": lazyTask, "tier": "fast"} // what the briefing alone suggests
	if useInstructions {
		if ex := exampleArgs(instr); ex != nil {
			args = ex
		}
	}
	outcome := func(id string, args map[string]any) (string, string, bool) {
		a.mcpToolCall(id, mcpTitle("spawn_agent"), args)
		text, isErr, err := c.callTool(ctx, "spawn_agent", args)
		if err != nil {
			if ctx.Err() != nil {
				return "", "", false
			}
			text, isErr = err.Error(), true
		}
		if isErr {
			// Claude Code's ACP adapter fences every tool result for display.
			a.toolUpdate(id, "failed", textContent("```\n"+text+"\n```"))
			return "refused", text, true
		}
		a.toolUpdate(id, "completed", textContent(text))
		return "ok", text, true
	}
	first, text, ok := outcome("mcp-lazy-1", args)
	if !ok {
		return "cancelled"
	}
	retry := "none"
	if first == "refused" {
		next := exampleArgs(text)
		if next == nil {
			a.say("lazy-spawn first=refused retry=none (the refusal shows no example): " + text)
			return "end_turn"
		}
		if retry, text, ok = outcome("mcp-lazy-2", next); !ok {
			return "cancelled"
		}
	}
	a.say("lazy-spawn first=" + first + " retry=" + retry + " report=" + text)
	return "end_turn"
}
