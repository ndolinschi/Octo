package orchestrator

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/ndolinschi/Octo/apps/harness/internal/agent"
	"github.com/ndolinschi/Octo/apps/harness/internal/instructions"
	"github.com/ndolinschi/Octo/apps/harness/internal/memory"
	"github.com/ndolinschi/Octo/apps/harness/internal/notemd"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
)

// Decision 88 (UI spec): the context report itemised. Everything here only
// measures what the request assembly already builds; it changes no prompt. Every
// token figure is an estimate (characters / 4, the harness's one estimator),
// scaled so that the items of a category add up to the category, which in turn
// adds up to used_tokens.

// ContextItem is one row inside a category (a tool, a file, a block of memory,
// a kind of message). Tokens are estimates (Estimated is always true here: even
// when used_tokens was reported, the split into rows is the harness's).
type ContextItem struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	Tokens int64  `json:"tokens"`
	// Group is a heading the UI may nest the row under ("Harness tools", a tool
	// server's name, a folder label, "Memory files").
	Group string `json:"group,omitempty"`
	// Path is the file the row is (instruction files "<folder label>:<path>",
	// memory files "/memories/...").
	Path string `json:"path,omitempty"`
	// Server is the tool server an MCP tool comes from.
	Server string `json:"server,omitempty"`
	// Loaded is false for a row that could be in the window and is not (not_loaded).
	Loaded bool `json:"loaded"`
	// Actions are what the UI may offer for the row: "open".
	Actions   []string `json:"actions,omitempty"`
	Estimated bool     `json:"estimated"`
}

// LargeMessage is one of the largest stored messages of the conversation the
// next request carries. Tokens is the raw estimate of the whole message (text,
// tool calls and tool results), not scaled: it overlaps the messages and
// tool_results categories and is not part of any sum.
type LargeMessage struct {
	MessageID int64  `json:"message_id"`
	Role      string `json:"role"`
	Tokens    int64  `json:"tokens"`
	Preview   string `json:"preview"`
}

// Names of the harness's own tool group and of the MCP server the harness gives
// an ACP orchestrator.
const (
	harnessToolsGroup = "Harness tools"
	acpHarnessServer  = "octo-harness"
	// maxNotLoaded bounds the not_loaded list (the largest rows are kept).
	maxNotLoaded = 50
	// largestMessages is how many messages the report names.
	largestMessages = 5
	previewChars    = 80
)

// itemW is a row with a weight in characters, before scaling to its category.
type itemW struct {
	ContextItem
	chars int
	// keep keeps the row when it scales to 0 tokens.
	keep bool
}

// itemSrc carries what Context learned while measuring, for the items.
type itemSrc struct {
	reg            *tools.Registry
	history        []anthropic.MessageParam
	compacted      bool
	compactionUpto int64
	// window is the window-mode assembly (nil in full mode and for ACP).
	window *assembly
	// currentID is the stored message of the latest user request.
	currentID int64
	toolW     []itemW
	mcpW      []itemW
}

// measureTools weighs every tool definition of reg and sets the mcp_tools
// category's characters (the tools category is the rest of the serialized list,
// so the old `tools` part is unchanged).
func (rt *runtime) measureTools(reg *tools.Registry, cat map[string]int, src *itemSrc) {
	var mcp int
	src.toolW, src.mcpW = toolWeights(reg)
	for _, w := range src.mcpW {
		mcp += w.chars
	}
	cat["mcp_tools"] = mcp
}

// toolWeights splits the registry's tools into the harness's own and the ones
// from tool servers (plugins' tool servers and --remote), each weighed by the
// size of its serialized definition.
func toolWeights(reg *tools.Registry) (own, mcp []itemW) {
	for _, u := range reg.AnthropicTools() {
		if u.OfTool == nil {
			continue
		}
		name := u.OfTool.Name
		raw, _ := json.Marshal(u)
		d, _ := reg.Get(name)
		if d.Server != "" {
			mcp = append(mcp, itemW{ContextItem: ContextItem{ID: "tool:" + d.Server + ":" + name, Label: d.Server + " · " + name,
				Group: d.Server, Server: d.Server, Loaded: true}, chars: len(raw)})
			continue
		}
		own = append(own, itemW{ContextItem: ContextItem{ID: "tool:" + name, Label: name, Group: harnessToolsGroup, Loaded: true}, chars: len(raw)})
	}
	return own, mcp
}

// fillItems fills Items of every category of a built-in agent's report, the
// not-loaded rows and the largest messages.
func (rt *runtime) fillItems(ctx context.Context, rep *ContextReport, a projectstore.Agent, cat map[string]int, src *itemSrc) error {
	isOrch := a.ParentID == nil
	w := map[string][]itemW{}
	w["system"] = rt.systemWeights(a, cat["system"], isOrch)
	w["instructions"] = instructionWeights(rt.instructionsOf(instrAgent(a)).set.Files)
	w["tools"], w["mcp_tools"] = src.toolW, src.mcpW
	if isOrch {
		w["notes"] = notesItems(rt.notes)
		w["agents"] = rt.agentWeights()
	}
	if src.window != nil {
		w["memory"] = memoryWeights(src.window)
	}
	kinds, results := messageKinds(src, cat)
	w["messages"], w["tool_results"] = kinds, results

	for i := range rep.Categories {
		c := &rep.Categories[i]
		c.Items = scaleItems(c.ID, c.Label, c.Tokens, w[c.ID])
		if c.ID == "messages" && isOrch && c.Tokens > 0 && !rt.windowMode() {
			c.Actions = []string{"compact"}
		}
	}
	if isOrch {
		nl, err := rt.notLoaded(ctx)
		if err != nil {
			return err
		}
		rep.NotLoaded = nl
	}
	lm, err := rt.largestMessages(ctx, a, src)
	if err != nil {
		return err
	}
	rep.LargestMessages = lm
	return nil
}

// windowMode reports the project's memory context mode "window".
func (rt *runtime) windowMode() bool {
	return memory.ParseSettings(rt.info.MemoryJSON).Context == memory.ContextWindow
}

// scaleItems scales the weights to the category's tokens (largest remainder, so
// they sum to it exactly) and lists them largest first. Zero rows are dropped
// unless marked keep. With tokens but nothing to weigh, the category is one row.
func scaleItems(id, label string, tokens int64, ws []itemW) []ContextItem {
	out := []ContextItem{}
	if tokens <= 0 && !anyKeep(ws) {
		return out
	}
	weights := make([]int64, len(ws))
	var sum int64
	for i, w := range ws {
		weights[i] = int64(max(w.chars, 0))
		sum += weights[i]
	}
	if sum == 0 {
		if tokens > 0 {
			out = append(out, ContextItem{ID: id, Label: label, Tokens: tokens, Loaded: true, Estimated: true})
		}
		return out
	}
	for i, t := range scaleTo(weights, tokens) {
		if t == 0 && !ws[i].keep {
			continue
		}
		it := ws[i].ContextItem
		it.Tokens, it.Estimated = t, true
		out = append(out, it)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Tokens > out[j].Tokens })
	return out
}

func anyKeep(ws []itemW) bool {
	for _, w := range ws {
		if w.keep {
			return true
		}
	}
	return false
}

// systemWeights splits the briefing: the project brief, the user's custom
// instructions, the pinned plan and mode note, and the rest (the role and
// working guidance). total is the briefing category's characters.
func (rt *runtime) systemWeights(a projectstore.Agent, total int, isOrch bool) []itemW {
	return briefingWeights(rt, total, isOrch && a.ParentID == nil, "Role and working guidance")
}

func briefingWeights(rt *runtime, total int, orchestrator bool, restLabel string) []itemW {
	custom := 0
	if rt.info.Instructions != "" {
		custom = len(rt.info.Instructions) + len("\nCustom instructions from the user:\n") + 1
	}
	brief := max(len(rt.brief())-custom, 0)
	ws := []itemW{
		{ContextItem: ContextItem{ID: "system:brief", Label: "Project brief", Loaded: true}, chars: brief},
		{ContextItem: ContextItem{ID: "system:custom", Label: "Custom instructions", Loaded: true}, chars: custom},
	}
	if orchestrator {
		ws = append(ws,
			itemW{ContextItem: ContextItem{ID: "system:plan", Label: "Pinned plan", Loaded: true}, chars: len(rt.planSection())},
			itemW{ContextItem: ContextItem{ID: "system:mode", Label: "Mode note", Loaded: true}, chars: len(rt.modeSection())})
	}
	var known int
	for _, w := range ws {
		known += w.chars
	}
	return append(ws, itemW{ContextItem: ContextItem{ID: "system:guidance", Label: restLabel, Loaded: true}, chars: max(total-known, 0)})
}

// instructionWeights is one row per instruction file, by what the agent gets of it.
func instructionWeights(files []instructions.File) []itemW {
	ws := make([]itemW, 0, len(files))
	for _, f := range files {
		group, _, _ := strings.Cut(f.Path, ":")
		ws = append(ws, itemW{ContextItem: ContextItem{ID: "instructions:" + f.Path, Label: f.Path, Group: group, Path: f.Path, Loaded: true,
			Actions: []string{"open"}}, chars: f.Used + len(f.Path) + 10})
	}
	return ws
}

// notesItems are the rows of the notes category, mirroring notesBlock: one row
// per pinned note (whole, "open" and "unpin"), then one row for the index of
// every note (descriptions only; bodies are never in the prompt). The rows are
// scaled to the category's tokens.
func notesItems(notes []projectstore.Note) []itemW {
	var ws []itemW
	if len(notes) == 0 {
		return ws
	}
	for _, n := range notes {
		if n.Pinned {
			ws = append(ws, itemW{ContextItem: ContextItem{ID: "note:" + n.ID, Label: n.Title, Group: "Pinned notes", Loaded: true,
				Actions: []string{"open", "unpin"}}, chars: len("### \n\n") + len(n.Title) + len(n.Content)})
		}
	}
	lines, _ := notemd.BuildIndex(noteEntries(notes), notemd.IndexBudget, projectstore.EstimateTokens)
	chars := len(notesHeader)
	for _, l := range lines {
		chars += len(l) + 1
	}
	return append(ws, itemW{ContextItem: ContextItem{ID: "notes:index", Label: fmt.Sprintf("Notes index (%d notes)", len(notes)), Loaded: true}, chars: chars})
}

// memoryWeights are the blocks the window mode puts in front of the messages:
// the memory index, the open tasks and the current facts.
func memoryWeights(as *assembly) []itemW {
	var ws []itemW
	for _, b := range as.lead {
		ws = append(ws, itemW{ContextItem: ContextItem{ID: "memory:" + b.Name, Label: "Memory index", Group: "Memory", Loaded: true}, chars: len(b.Text)})
	}
	if as.tasks != nil {
		ws = append(ws, itemW{ContextItem: ContextItem{ID: "memory:" + as.tasks.Name, Label: "Open tasks", Group: "Memory", Loaded: true}, chars: len(as.tasks.Text)})
	}
	if as.facts != nil {
		ws = append(ws, itemW{ContextItem: ContextItem{ID: "memory:" + as.facts.Name, Label: "Current facts", Group: "Memory", Loaded: true}, chars: len(as.facts.Text)})
	}
	return ws
}

// agentWeights is what spawn_agent's briefing says about the external (ACP)
// agents it can hand work to: one row per available agent and the note itself.
func (rt *runtime) agentWeights() []itemW {
	text := rt.acpPrompt()
	if text == "" {
		return nil
	}
	var ws []itemW
	used := 0
	for _, ag := range rt.acpAgents() {
		n := len(ag.ID) + len(ag.Label) + 5
		used += n
		ws = append(ws, itemW{ContextItem: ContextItem{ID: "agent:" + ag.ID, Label: pluginAgentName(ag), Group: "External agents", Loaded: true}, chars: n})
	}
	return append(ws, itemW{ContextItem: ContextItem{ID: "agent:note", Label: "How to delegate to external agents", Loaded: true}, chars: max(len(text)-used, 0)})
}

func pluginAgentName(a plugins.Agent) string {
	if a.Label != "" {
		return a.Label
	}
	return a.ID
}

// messageKinds weighs the conversation by kind (what the user asked, what the
// assistant said, thinking, tool calls) and the tool results by tool name. The
// latest request and the memory blocks, which have categories of their own, are
// taken off the user requests first. The built-in loop does not ask for
// thinking, so that row is 0 tokens (kept so the report always shows it).
func messageKinds(src *itemSrc, cat map[string]int) (kinds, results []itemW) {
	var user, assistant, calls int
	byTool := map[string]int{}
	order := []string{}
	names := map[string]string{}
	for i, m := range src.history {
		if src.compacted && i == 0 {
			continue
		}
		fromUser := m.OfUser != nil
		for _, b := range agent.ContentOf(m) {
			switch {
			case b.OfText != nil:
				if fromUser {
					user += len(b.OfText.Text)
				} else {
					assistant += len(b.OfText.Text)
				}
			case b.OfToolUse != nil:
				raw, _ := json.Marshal(b.OfToolUse.Input)
				calls += len(b.OfToolUse.Name) + len(raw)
				names[b.OfToolUse.ID] = b.OfToolUse.Name
			case b.OfToolResult != nil:
				name := names[b.OfToolResult.ToolUseID]
				if name == "" {
					name = "tool"
				}
				var r int
				for _, c := range b.OfToolResult.Content {
					if c.OfText != nil {
						r += len(c.OfText.Text)
					}
				}
				if _, ok := byTool[name]; !ok {
					order = append(order, name)
				}
				byTool[name] += r
			}
		}
	}
	user = max(user-cat["memory"]-cat["current_request"], 0)
	kinds = []itemW{
		{ContextItem: ContextItem{ID: "messages:user", Label: "User requests", Group: "Conversation", Loaded: true}, chars: user, keep: true},
		{ContextItem: ContextItem{ID: "messages:assistant", Label: "Assistant text", Group: "Conversation", Loaded: true}, chars: assistant, keep: true},
		{ContextItem: ContextItem{ID: "messages:thinking", Label: "Thinking", Group: "Conversation", Loaded: true}, chars: 0, keep: true},
		{ContextItem: ContextItem{ID: "messages:tool_calls", Label: "Tool calls", Group: "Conversation", Loaded: true}, chars: calls},
	}
	for _, n := range order {
		results = append(results, itemW{ContextItem: ContextItem{ID: "tool_results:" + n, Label: n, Group: "Tool results", Loaded: true}, chars: byTool[n]})
	}
	return kinds, results
}

// notLoaded lists what could be in the window and is not: the memory files
// (the window mode's index names them; their text is read with the memory tool),
// each with what loading it would add. The largest maxNotLoaded are kept.
func (rt *runtime) notLoaded(ctx context.Context) ([]ContextItem, error) {
	files, err := rt.memory().DB.Files(ctx)
	if err != nil {
		return nil, err
	}
	out := []ContextItem{}
	for _, f := range files {
		out = append(out, ContextItem{ID: "memory_file:" + f.Path, Label: f.Path, Tokens: projectstore.EstimateTokens(f.Size), Group: "Memory files",
			Path: f.Path, Loaded: false, Actions: []string{"open"}, Estimated: true})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Tokens > out[j].Tokens })
	if len(out) > maxNotLoaded {
		out = out[:maxNotLoaded]
	}
	return out, nil
}

// largestMessages names the biggest messages of the conversation the next
// request carries (not the latest request, which has its own category). In the
// window mode the messages sent are the window's reduced exchanges, so those are
// ranked instead (an exchange's request and answer, by the first and last message
// of the exchange).
func (rt *runtime) largestMessages(ctx context.Context, a projectstore.Agent, src *itemSrc) ([]LargeMessage, error) {
	var all []LargeMessage
	if src.window != nil {
		for _, e := range src.window.window {
			if len(e.ids) == 0 {
				continue
			}
			all = append(all,
				LargeMessage{MessageID: e.ids[0], Role: "user", Tokens: tokensOf(e.user), Preview: previewOf(e.user)},
				LargeMessage{MessageID: e.ids[len(e.ids)-1], Role: "assistant", Tokens: tokensOf(e.assistant), Preview: previewOf(e.assistant)})
		}
	} else {
		stored, err := rt.db.Messages(ctx, a.ID)
		if err != nil {
			return nil, err
		}
		for _, m := range stored {
			if (src.compacted && m.ID <= src.compactionUpto) || m.ID == src.currentID {
				continue
			}
			chars, preview := storedSize(m)
			if chars > 0 {
				all = append(all, LargeMessage{MessageID: m.ID, Role: m.Role, Tokens: projectstore.EstimateTokens(chars), Preview: preview})
			}
		}
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].Tokens > all[j].Tokens })
	if len(all) > largestMessages {
		all = all[:largestMessages]
	}
	if all == nil {
		all = []LargeMessage{}
	}
	return all, nil
}

// storedSize is the characters a stored message puts into a request and a
// one-line preview (its text, else the first tool call or result).
func storedSize(m projectstore.Message) (int, string) {
	var n int
	var text, fallback string
	for _, b := range m.Content {
		switch b.Type {
		case "text":
			if b.Text != nil {
				n += len(*b.Text)
				if text == "" {
					text = *b.Text
				}
			}
		case "tool_use":
			name := ""
			if b.Name != nil {
				name = *b.Name
			}
			n += len(name) + len(b.Input)
			if fallback == "" {
				fallback = "[call " + name + "]"
			}
		case "tool_result":
			if b.Content != nil {
				n += len(*b.Content)
				if fallback == "" {
					fallback = "[result] " + *b.Content
				}
			}
		}
	}
	if strings.TrimSpace(text) == "" {
		text = fallback
	}
	return n, previewOf(text)
}

// previewOf is the first previewChars characters of s on one line.
func previewOf(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > previewChars {
		return string(r[:previewChars-1]) + "…"
	}
	return s
}

// acpContextItems is the report of an ACP orchestrator (rule f): the agent
// reported how much of its window is used; of that the harness itemises only what
// it sends (the briefing, the MCP tools it exposes, the project notes, the
// window-mode memory blocks, the delegation note) and the rest is one row
// "Inside the agent". The harness's figures are estimates of what it sent, and
// are scaled down if they exceed what the agent reported. Without a report
// nothing is invented: categories stay empty.
func (rt *runtime) acpContextItems(ctx context.Context, rep *ContextReport, a projectstore.Agent, src *itemSrc) error {
	if nl, err := rt.notLoaded(ctx); err != nil {
		return err
	} else {
		rep.NotLoaded = nl
	}
	if rep.Estimated || rep.UsedTokens <= 0 {
		return nil
	}
	agents := len(rt.acpPrompt())
	acpReg := src.reg.Without("read_file", "edit", "glob", "web_fetch")
	own, remote := toolWeights(acpReg)
	var mcpW []itemW // the agent sees every tool through the one MCP server
	for _, w := range append(own, remote...) {
		name := strings.TrimPrefix(w.Label, w.Server+" · ")
		w.Group, w.Server = acpHarnessServer, acpHarnessServer
		w.ID, w.Label = "tool:"+acpHarnessServer+":"+name, acpHarnessServer+" · "+name
		mcpW = append(mcpW, w)
	}
	var mcpChars int
	for _, w := range mcpW {
		mcpChars += w.chars
	}
	var memW []itemW
	if rt.windowMode() {
		as, err := rt.assembleWindow(ctx, a, memory.ParseSettings(rt.info.MemoryJSON))
		if err != nil {
			return err
		}
		memW = memoryWeights(as)
	}
	var memChars int
	for _, w := range memW {
		memChars += w.chars
	}
	rows := []struct {
		id, label string
		chars     int
		ws        []itemW
	}{
		{"system", "Briefing", max(len(rt.acpBriefing())-agents, 0), nil},
		{"mcp_tools", "MCP tools", mcpChars, mcpW},
		{"notes", "Project notes", len(notesBlock(rt.notes)), notesItems(rt.notes)},
		{"memory", "Memory", memChars, memW},
		{"agents", "Sub-agent definitions", agents, rt.agentWeights()},
	}
	rows[0].ws = briefingWeights(rt, rows[0].chars, true, "Role and working guidance")
	est := make([]int64, len(rows))
	var total int64
	for i, r := range rows {
		est[i] = projectstore.EstimateTokens(r.chars)
		total += est[i]
	}
	if total > rep.UsedTokens {
		est = scaleTo(est, rep.UsedTokens)
		total = rep.UsedTokens
	}
	for i, r := range rows {
		if est[i] == 0 {
			continue
		}
		rep.Categories = append(rep.Categories, ContextCategory{ID: r.id, Label: r.label, Tokens: est[i], Items: scaleItems(r.id, r.label, est[i], r.ws)})
	}
	inside := "Inside the agent — not itemised by " + rt.acpAgentLabel()
	if rest := rep.UsedTokens - total; rest > 0 {
		rep.Categories = append(rep.Categories, ContextCategory{ID: "agent", Label: inside, Tokens: rest,
			Items: []ContextItem{{ID: "agent:inside", Label: inside, Tokens: rest, Loaded: true, Estimated: true}}})
	}
	return nil
}

// acpAgentLabel names the project's ACP orchestrator for the "inside" row.
func (rt *runtime) acpAgentLabel() string {
	id, _, ok := plugins.ParseACPRef(rt.models.Orchestrator)
	if !ok {
		return "the agent"
	}
	for _, ag := range rt.o.agents() {
		if ag.ID == id {
			return pluginAgentName(ag)
		}
	}
	return id
}
