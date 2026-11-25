package orchestrator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/ndolinschi/Octo/apps/harness/internal/agent"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/memory"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
)

// Errors of a manual compaction.
var (
	// ErrNothingToCompact: the conversation has nothing a summary would replace.
	ErrNothingToCompact = errors.New("orchestrator: nothing to compact")
	// ErrCompactUnsupported: the orchestrator is an ACP agent (it compacts its own context) or the
	// project builds the context from memory blocks (the window mode never sends a summary).
	ErrCompactUnsupported = errors.New("orchestrator: compaction does not apply here")
)

// CompactUnsupportedReason is the text that goes with ErrCompactUnsupported.
type CompactUnsupportedReason string

func (r CompactUnsupportedReason) Error() string { return string(r) }
func (r CompactUnsupportedReason) Unwrap() error { return ErrCompactUnsupported }

// CompactResult describes the marker a compaction stored.
type CompactResult struct {
	UptoMessageID int64  `json:"upto_message_id"`
	At            string `json:"at"`
	SummaryTokens int64  `json:"summary_tokens"`
	// MessageCount is how many messages the summary replaces.
	MessageCount int  `json:"message_count"`
	Manual       bool `json:"manual"`
}

const compactPrompt = "You compact the conversation of a software project so that work can continue from a short summary. " +
	"Write the summary as markdown with these sections, leaving out any that are empty: Goal (what the user wants), Decisions (what was decided and why), " +
	"Work done (files changed, commands that mattered, results), State (what is true now), Open questions and next steps. " +
	"Keep names, paths, commands, numbers and the user's exact wording of requirements; drop pleasantries and dead ends. Under 1200 words. Reply with the summary only."

// compactInputCap bounds the transcript handed to the summarising model (characters).
const compactInputCap = 120_000

// Compact summarises the orchestrator's conversation now with one call of the side
// model and stores the summary as a compaction marker (manual): the next request
// sends the summary in place of the messages it covers, which stay on disk and in
// the transcript. Refused while a turn runs (ErrTurnInProgress), for an ACP
// orchestrator and in the window memory mode (ErrCompactUnsupported), and when
// there is nothing to compact (ErrNothingToCompact).
func (o *Orchestrator) Compact(ctx context.Context, pid string) (CompactResult, error) {
	return o.CompactSession(ctx, pid, "")
}

// CompactSession is Compact for one main session ("": the default).
func (o *Orchestrator) CompactSession(ctx context.Context, pid, sid string) (CompactResult, error) {
	if o.baseCtx.Err() != nil {
		return CompactResult{}, ErrShuttingDown
	}
	db, err := o.store.Get(ctx, pid)
	if err != nil {
		return CompactResult{}, err
	}
	if sid, err = o.mainSession(ctx, db, sid); err != nil {
		return CompactResult{}, err
	}
	key := skey(pid, sid)
	turnCtx, cancel := context.WithCancel(o.baseCtx)
	defer cancel()
	if !o.claim(key, cancel) { // the session's turn slot: no turn runs while its history is being replaced
		return CompactResult{}, ErrTurnInProgress
	}
	defer func() {
		// A message sent while the history was being replaced was queued: start it now.
		o.release(key)
		o.qmu.Lock()
		defer o.qmu.Unlock()
		o.startNext(db, sid)
	}()
	orch, err := db.RootAgent(ctx, sid)
	if err != nil {
		return CompactResult{}, err
	}
	rt, err := o.newSessionRuntime(ctx, db, sid)
	if err != nil {
		return CompactResult{}, err
	}
	switch {
	case rt.isACPOrchestrator():
		return CompactResult{}, CompactUnsupportedReason("the orchestrator is an ACP agent that does not advertise a compact command (it advertises its commands when its session starts): it compacts its own context")
	case memory.ParseSettings(rt.info.MemoryJSON).Context == memory.ContextWindow:
		return CompactResult{}, CompactUnsupportedReason("this project's memory mode is window: only recent exchanges are sent, there is no history to compact")
	}
	if msg := o.builtinOff(); msg != "" {
		return CompactResult{}, noBuiltinLoopError{msg}
	}
	prev, hadPrev, err := db.LatestCompaction(ctx, orch.ID)
	if err != nil {
		return CompactResult{}, err
	}
	stored, err := db.Messages(ctx, orch.ID)
	if err != nil {
		return CompactResult{}, err
	}
	count := 0
	for _, m := range stored {
		if !hadPrev || m.ID > prev.UptoMessageID {
			count++
		}
	}
	if count < 2 {
		return CompactResult{}, ErrNothingToCompact
	}
	history, err := rt.loadHistoryWith(ctx, orch.ID, nil) // images become "[image: name, WxH]"
	if err != nil {
		return CompactResult{}, err
	}
	summary, err := o.summarize(turnCtx, rt, orch.ID, "compact", compactPrompt, history)
	if err != nil {
		return CompactResult{}, err
	}
	c, err := db.AddManualCompaction(ctx, orch.ID, summary, count)
	if err != nil {
		return CompactResult{}, err
	}
	out := CompactResult{UptoMessageID: c.UptoMessageID, At: c.CreatedAt, SummaryTokens: c.SummaryTokens(), MessageCount: count, Manual: true}
	o.hub.Publish(pid, events.AgentCompacted, map[string]any{
		"agent_id": orch.ID, "upto_message_id": c.UptoMessageID, "summary_tokens": out.SummaryTokens, "at": c.CreatedAt,
		"manual": true, "message_count": count, "session_id": sid,
	})
	o.hub.Publish(pid, events.ContextUpdated, map[string]any{"project_id": pid, "session_id": sid})
	return out, nil
}

// renderHistory is the conversation as plain text for the summariser: texts in
// full, each tool call a line with its result clipped; the oldest part is cut
// when the whole exceeds max characters.
func renderHistory(history []anthropic.MessageParam, max int) string {
	var b strings.Builder
	results := map[string]string{}
	for _, m := range history {
		for _, blk := range agent.ContentOf(m) {
			if blk.OfToolResult != nil {
				var t string
				for _, c := range blk.OfToolResult.Content {
					if c.OfText != nil {
						t += c.OfText.Text
					}
				}
				results[blk.OfToolResult.ToolUseID] = t
			}
		}
	}
	for _, m := range history {
		role := "USER"
		if raw, err := json.Marshal(m); err == nil && strings.Contains(string(raw), `"role":"assistant"`) {
			role = "ASSISTANT"
		}
		for _, blk := range agent.ContentOf(m) {
			switch {
			case blk.OfText != nil:
				fmt.Fprintf(&b, "%s: %s\n\n", role, blk.OfText.Text)
			case blk.OfToolUse != nil:
				raw, _ := json.Marshal(blk.OfToolUse.Input)
				fmt.Fprintf(&b, "[tool %s %s -> %s]\n\n", blk.OfToolUse.Name, oneLineOf(string(raw), 200), oneLineOf(results[blk.OfToolUse.ID], 300))
			}
		}
	}
	s := b.String()
	if len(s) > max {
		s = "[... the oldest part of the conversation is left out ...]\n" + s[len(s)-max:]
	}
	return s
}

// summarize is one call of the side model that turns the history into a summary under the
// given instructions; the call's usage is recorded under role.
func (o *Orchestrator) summarize(ctx context.Context, rt *runtime, agentID, role, system string, history []anthropic.MessageParam) (string, error) {
	input := rt.redact(renderHistory(history, compactInputCap))
	cctx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	loop := agent.Loop{
		Client: o.opts.Client, Registry: tools.NewRegistry(), Model: rt.models.SideModel(), System: system,
		MaxTurns: 1, Stream: false, SessionID: role + ":" + agentID,
		Sink:            &digestSink{rt: rt, agentID: agentID, role: role},
		NoPromptCaching: o.opts.NoPromptCaching, Limits: o.opts.Limits, Router: o.opts.Router,
		Hints: rt.sideHints(), Gate: rt.loopGate(),
	}
	res, err := loop.Run(cctx, []anthropic.MessageParam{anthropic.NewUserMessage(anthropic.NewTextBlock(input))})
	if err != nil {
		return "", err
	}
	summary := strings.TrimSpace(rt.redact(res.Text))
	if summary == "" {
		return "", errors.New("the model returned an empty summary; the history was left as it is")
	}
	return summary, nil
}
