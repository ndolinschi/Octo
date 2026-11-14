package orchestrator

import (
	"context"
	"encoding/json"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/ndolinschi/Octo/apps/harness/internal/agent"
	"github.com/ndolinschi/Octo/apps/harness/internal/memory"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// Keys of the parts of an agent's context.
const (
	PartSystem      = "system"
	PartTools       = "tools"
	PartNotes       = "notes"
	PartMessages    = "messages"
	PartToolResults = "tool_results"
	PartSummary     = "summary"
)

var partOrder = []string{PartSystem, PartTools, PartNotes, PartMessages, PartToolResults, PartSummary}

// ContextPart is one slice of the context, in tokens.
type ContextPart struct {
	Key    string `json:"key"`
	Tokens int64  `json:"tokens"`
}

// ContextReport is what an agent's next request would contain, by part.
// UsedTokens is the last reported input size when the model reported one
// (Estimated false); the split into parts is always an estimate.
//
// The fields after Parts (parity B7) are additive. Categories are the same
// request split the way the context button shows it (they sum to UsedTokens,
// the same scaling as Parts); Source says who measured: "harness" (built from the
// assembly that builds the next request) or "agent" (an ACP agent's own report,
// no categories).
type ContextReport struct {
	AgentID      string        `json:"agent_id"`
	Model        string        `json:"model"`
	WindowTokens *int64        `json:"window_tokens"`
	UsedTokens   int64         `json:"used_tokens"`
	Estimated    bool          `json:"estimated"`
	Parts        []ContextPart `json:"parts"`

	Source string `json:"source"`
	// Window is the size used for Free: the model's configured window, else
	// DefaultContextWindow (the same default tool-result clearing assumes);
	// WindowSource says which ("configured", "default", "agent"). Null for an ACP
	// agent that reported no size.
	Window       *int64 `json:"window"`
	WindowSource string `json:"window_source"`
	// ReservedTokens is room kept for the answer (the loop's max_tokens); Free is
	// the window minus used minus reserved, never below 0 (null with no window).
	ReservedTokens *int64 `json:"reserved_tokens,omitempty"`
	FreeTokens     *int64 `json:"free_tokens"`
	// CompactedAt is when the history was last compacted (omitted when never).
	CompactedAt string            `json:"compacted_at,omitempty"`
	Categories  []ContextCategory `json:"categories"`
	LastRequest *LastRequest      `json:"last_request"`
	// Images counts the images in the messages the next request carries and
	// ImageTokens their estimated tokens (inside the messages part).
	Images      int   `json:"images"`
	ImageTokens int64 `json:"image_tokens"`

	// The fields below are decision 88 (see context_items.go): rows that could be
	// loaded and are not, the compaction buffer (0: the harness knows none, the
	// router decides when to compact) and the largest messages.
	NotLoaded       []ContextItem  `json:"not_loaded"`
	BufferTokens    int64          `json:"buffer_tokens"`
	LargestMessages []LargeMessage `json:"largest_messages"`
}

// reservedOutputTokens is the room the loop keeps for an answer: its default max_tokens.
const reservedOutputTokens = 8192

// DefaultContextWindow is the window assumed when none is configured
// (HARNESS_CONTEXT_WINDOWS); tool-result clearing uses the same figure.
const DefaultContextWindow = defaultClearWindow

// ContextCategory is one slice of the context for the context button.
type ContextCategory struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	Tokens int64  `json:"tokens"`
	// Items are the rows inside the category; they add up to Tokens.
	Items []ContextItem `json:"items"`
	// Actions are what the report may offer for the whole category ("compact").
	Actions []string `json:"actions,omitempty"`
}

// LastRequest is the newest orchestrator request's usage as the model reported
// it: Input is everything it read (uncached, cache reads and cache writes),
// Cached the part read from the cache, Output the answer.
type LastRequest struct {
	Input  int64 `json:"input"`
	Cached int64 `json:"cached"`
	Output int64 `json:"output"`
}

var categoryOrder = []struct{ id, label string }{
	{"system", "Briefing"}, {"instructions", "Project instruction files"}, {"tools", "Tool definitions"}, {"mcp_tools", "MCP tools"},
	{"notes", "Project notes"}, {"memory", "Memory"}, {"agents", "Sub-agent definitions"}, {"messages", "Conversation"},
	{"tool_results", "Tool results"}, {"summary", "Compacted summary"}, {"current_request", "Current request"},
}

// Context reports the context of the project's orchestrator (agentID empty) or
// of one agent. It reads a snapshot and never takes the turn lock, so it works
// while a turn runs. projectstore.ErrNotFound means the project or agent.
func (o *Orchestrator) Context(ctx context.Context, projectID, agentID string) (ContextReport, error) {
	db, err := o.store.Get(ctx, projectID)
	if err != nil {
		return ContextReport{}, err
	}
	var a projectstore.Agent
	if agentID == "" {
		a, err = db.Orchestrator(ctx)
	} else {
		a, err = db.Agent(ctx, agentID)
	}
	if err != nil {
		return ContextReport{}, err
	}
	rt, err := o.newSessionRuntime(ctx, db, a.SessionID)
	if err != nil {
		return ContextReport{}, err
	}
	var history []anthropic.MessageParam
	if a.ParentID == nil {
		history, err = rt.orchestratorHistory(ctx, a, false)
	} else {
		history, err = rt.loadHistory(ctx, a.ID)
	}
	if err != nil {
		return ContextReport{}, err
	}
	reg, err := rt.registry(a)
	if err != nil {
		return ContextReport{}, err
	}
	chars := map[string]int{}
	if a.ParentID == nil {
		static, notes := rt.orchestratorPromptParts()
		chars[PartSystem], chars[PartNotes] = len(static), len(notes)
	} else {
		chars[PartSystem] = len(rt.systemPrompt(a))
	}
	// The instruction files are inside the system prompt; the categories show them apart.
	catChars := map[string]int{"instructions": len(rt.instructionsOf(instrAgent(a)).text)}
	if raw, err := json.Marshal(reg.AnthropicTools()); err == nil {
		chars[PartTools] = len(raw)
	}
	comp, compacted, err := db.LatestCompaction(ctx, a.ID)
	if err != nil {
		return ContextReport{}, err
	}
	if a.ParentID == nil && memory.ParseSettings(rt.info.MemoryJSON).Context == memory.ContextWindow {
		compacted = false // the window mode sends no summary
	}
	for i, m := range history {
		if compacted && i == 0 {
			chars[PartSummary] += messageChars(m, nil)
			continue
		}
		var results int
		chars[PartMessages] += messageChars(m, &results)
		chars[PartToolResults] += results
	}

	src := &itemSrc{reg: reg, history: history, compacted: compacted, compactionUpto: comp.UptoMessageID}
	if a.ParentID == nil {
		if err := rt.splitMemoryAndRequest(ctx, a, history, chars, catChars, src); err != nil {
			return ContextReport{}, err
		}
		catChars["agents"] = len(rt.acpPrompt())
	}
	rt.measureTools(reg, catChars, src)
	rep := ContextReport{AgentID: a.ID, Model: a.Model, Categories: []ContextCategory{}, NotLoaded: []ContextItem{}, LargestMessages: []LargeMessage{}}
	rep.Images, rep.ImageTokens = countImages(history)
	served := ""
	reported, ok, err := db.LastReportedContext(ctx, a.ID)
	if err != nil {
		return ContextReport{}, err
	}
	switch {
	case ok:
		rep.UsedTokens, served = reported.Tokens, reported.ServedModel
	case a.ContextUsed != nil:
		rep.UsedTokens = *a.ContextUsed // an ACP agent's own report
	default:
		rep.Estimated = true
	}
	est := make([]int64, len(partOrder))
	var estTotal int64
	for i, k := range partOrder {
		est[i] = projectstore.EstimateTokens(chars[k])
		estTotal += est[i]
	}
	if rep.Estimated {
		rep.UsedTokens = estTotal
	}
	for i, tokens := range scaleTo(est, rep.UsedTokens) {
		rep.Parts = append(rep.Parts, ContextPart{Key: partOrder[i], Tokens: tokens})
	}
	rep.WindowTokens = rt.window(served, a)
	if err := rt.finishContextReport(ctx, &rep, a, chars, catChars, src); err != nil {
		return ContextReport{}, err
	}
	return rep, nil
}

// instrAgent is the agent whose instruction files a context report counts (the
// orchestrator's are keyed without an id).
func instrAgent(a projectstore.Agent) projectstore.Agent {
	if a.ParentID == nil {
		return projectstore.Agent{}
	}
	return a
}

// splitMemoryAndRequest moves, out of the conversation count and into their own
// categories, the memory blocks the window mode puts in front of the messages and
// the user's latest request.
func (rt *runtime) splitMemoryAndRequest(ctx context.Context, a projectstore.Agent, history []anthropic.MessageParam, chars, cat map[string]int, src *itemSrc) error {
	st := memory.ParseSettings(rt.info.MemoryJSON)
	if st.Context == memory.ContextWindow && !rt.isACPOrchestrator() {
		as, err := rt.assembleWindow(ctx, a, st)
		if err != nil {
			return err
		}
		mem := 0
		for _, b := range as.lead {
			mem += len(b.Text)
		}
		if as.tasks != nil {
			mem += len(as.tasks.Text)
		}
		if as.facts != nil {
			mem += len(as.facts.Text)
		}
		mem = min(mem, chars[PartMessages])
		cat["memory"], chars[PartMessages] = mem, chars[PartMessages]-mem
		src.window = as
	}
	stored, err := rt.db.LiveMessages(ctx, a.ID)
	if err != nil {
		return err
	}
	for i := len(stored) - 1; i >= 0; i-- {
		if t := messageText(stored[i]); stored[i].Role == "user" && t != "" {
			n := min(len(t), chars[PartMessages])
			cat["current_request"], chars[PartMessages] = n, chars[PartMessages]-n
			src.currentID = stored[i].ID
			break
		}
	}
	return nil
}

// finishContextReport fills the additive fields of a report.
func (rt *runtime) finishContextReport(ctx context.Context, rep *ContextReport, a projectstore.Agent, chars, cat map[string]int, src *itemSrc) error {
	isAgent := a.ParentID == nil && rt.isACPOrchestrator()
	rep.Source = "harness"
	if isAgent {
		rep.Source = "agent"
	}
	switch {
	case rep.WindowTokens != nil && isAgent:
		rep.Window, rep.WindowSource = rep.WindowTokens, "agent"
	case rep.WindowTokens != nil:
		rep.Window, rep.WindowSource = rep.WindowTokens, "configured"
	case !isAgent:
		w := int64(DefaultContextWindow)
		rep.Window, rep.WindowSource = &w, "default"
	default:
		rep.WindowSource = "unknown"
	}
	if !isAgent {
		r := int64(reservedOutputTokens)
		rep.ReservedTokens = &r
	}
	if rep.Window != nil {
		var reserved int64
		if rep.ReservedTokens != nil {
			reserved = *rep.ReservedTokens
		}
		free := max(*rep.Window-rep.UsedTokens-reserved, 0)
		rep.FreeTokens = &free
	}
	if c, ok, err := rt.db.LatestCompaction(ctx, a.ID); err != nil {
		return err
	} else if ok && !c.Cleared {
		rep.CompactedAt = c.CreatedAt
	}
	if u, ok, err := rt.db.LastAgentUsage(ctx, a.ID); err != nil {
		return err
	} else if ok {
		rep.LastRequest = &LastRequest{Input: u.Input + u.CacheRead + u.CacheWrite, Cached: u.CacheRead, Output: u.Output}
	}
	if isAgent {
		// An ACP agent owns its context: only what the harness sends is itemised
		// (and only when the agent reported its size, else nothing is invented).
		return rt.acpContextItems(ctx, rep, a, src)
	}
	// The categories: the same characters as Parts, split further, scaled to the used total.
	cat["system"] = max(chars[PartSystem]-cat["instructions"]-cat["agents"], 0)
	cat["tools"], cat["notes"] = max(chars[PartTools]-cat["mcp_tools"], 0), chars[PartNotes]
	cat["messages"], cat["tool_results"], cat["summary"] = chars[PartMessages], chars[PartToolResults], chars[PartSummary]
	est := make([]int64, len(categoryOrder))
	for i, c := range categoryOrder {
		est[i] = projectstore.EstimateTokens(cat[c.id])
	}
	for i, tokens := range scaleTo(est, rep.UsedTokens) {
		rep.Categories = append(rep.Categories, ContextCategory{ID: categoryOrder[i].id, Label: categoryOrder[i].label, Tokens: tokens})
	}
	return rt.fillItems(ctx, rep, a, cat, src)
}

// window finds the context size: the served model's, the requested model's,
// else what an ACP agent reported.
func (rt *runtime) window(served string, a projectstore.Agent) *int64 {
	for _, m := range []string{served, a.Model} {
		if m == "" {
			continue
		}
		if w := rt.o.opts.Windows.Lookup(m); w != nil {
			return w
		}
	}
	return a.ContextSize
}

// scaleTo scales parts proportionally so they sum to total exactly (largest
// remainder). With nothing to scale, or a zero total, it returns zeros.
func scaleTo(parts []int64, total int64) []int64 {
	out := make([]int64, len(parts))
	var sum int64
	for _, p := range parts {
		sum += p
	}
	if sum == 0 || total <= 0 {
		return out
	}
	rem := make([]int64, len(parts))
	var assigned int64
	for i, p := range parts {
		out[i] = p * total / sum
		rem[i] = p * total % sum
		assigned += out[i]
	}
	for ; assigned < total; assigned++ {
		best := 0
		for i := range rem {
			if rem[i] > rem[best] {
				best = i
			}
		}
		out[best]++
		rem[best] = -1
	}
	// A part that holds something never reads as empty: a share that rounds to
	// zero gets one token, taken from the largest part. (Which parts round to
	// zero depends on the exact size of every part, such as the path in the
	// briefing, so without this an edge case flipped from run to run.)
	for i, p := range parts {
		if p <= 0 || out[i] > 0 {
			continue
		}
		big := 0
		for j := range out {
			if out[j] > out[big] {
				big = j
			}
		}
		if out[big] <= 1 {
			break
		}
		out[big]--
		out[i]++
	}
	return out
}

// messageChars counts the characters one message puts into the model's input.
// Tool result text is counted into *results (when given) instead of the total.
func messageChars(m anthropic.MessageParam, results *int) int {
	var n int
	for _, b := range agent.ContentOf(m) {
		switch {
		case b.OfText != nil:
			n += len(b.OfText.Text)
		case b.OfImage != nil:
			n += int(imageTokens(b)) * 4
		case b.OfToolUse != nil:
			raw, _ := json.Marshal(b.OfToolUse.Input)
			n += len(b.OfToolUse.Name) + len(raw)
		case b.OfToolResult != nil:
			var r int
			for _, c := range b.OfToolResult.Content {
				if c.OfText != nil {
					r += len(c.OfText.Text)
				}
			}
			if results != nil {
				*results += r
			} else {
				n += r
			}
		}
	}
	return n
}
