package orchestrator

import (
	"context"
	"encoding/json"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/ndolinschi/Octo/apps/harness/internal/agent"
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
type ContextReport struct {
	AgentID      string        `json:"agent_id"`
	Model        string        `json:"model"`
	WindowTokens *int64        `json:"window_tokens"`
	UsedTokens   int64         `json:"used_tokens"`
	Estimated    bool          `json:"estimated"`
	Parts        []ContextPart `json:"parts"`
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
	rt, err := o.newRuntime(ctx, db)
	if err != nil {
		return ContextReport{}, err
	}
	history, err := rt.loadHistory(ctx, a.ID)
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
	if raw, err := json.Marshal(reg.AnthropicTools()); err == nil {
		chars[PartTools] = len(raw)
	}
	_, compacted, err := db.LatestCompaction(ctx, a.ID)
	if err != nil {
		return ContextReport{}, err
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

	rep := ContextReport{AgentID: a.ID, Model: a.Model}
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
	return rep, nil
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
