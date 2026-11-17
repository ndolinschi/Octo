package orchestrator

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/memory"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// Sources of a clear's summary.
const (
	SummaryModel  = "model"  // one call of the fast-tier model (built-in loop)
	SummaryAgent  = "agent"  // the ACP agent, asked in its live session
	SummaryStored = "stored" // built from what is stored, without a model
)

const (
	// CarryOverTokens bounds what a cleared session hands to the next one (summary, open task
	// titles and the recall pointer together; tokens are the harness's estimate, chars / 4).
	CarryOverTokens = 600
	// agentSummaryTimeout is how long an ACP agent has to write the summary of a session being cleared.
	agentSummaryTimeout = 30 * time.Second
	maxCarryTasks       = 5
)

const summaryShape = "Sections (leave out any that are empty): Asked (what the user asked), Done (what was done), Decisions, " +
	"Unfinished (what is still open or next), Files (touched, with paths). Keep names, paths and numbers; under 200 words."

const clearPrompt = "The session of a software project is being cleared and work will continue in a new one that sees only your note. " +
	"Write that note as markdown. " + summaryShape + " Reply with the note only."

const clearAgentPrompt = "This session is being cleared; a new one will start from the note you write now. Do not use any tool and do not " +
	"change anything. Write the note as markdown. " + summaryShape + " Reply with the note only."

// ClearResult is what POST /clear answers.
type ClearResult struct {
	// ConversationID names the new session (the boundary); UptoMessageID is the last message of
	// the one that ended (0: it had none).
	ConversationID string `json:"conversation_id"`
	UptoMessageID  int64  `json:"upto_message_id"`
	At             string `json:"at"`
	// Title names the session that ended; Summary is its summary and SummarySource who wrote it
	// ("model", "agent" or "stored").
	Title         string `json:"title"`
	Summary       string `json:"summary"`
	SummarySource string `json:"summary_source"`
	// SessionID is the memory session the next request joins; PreviousSessionID the one that ended
	// (memory M4; "" when the project had none). The ended session keeps the summary.
	SessionID         string `json:"session_id,omitempty"`
	PreviousSessionID string `json:"previous_session_id,omitempty"`
}

// Clear is ClearSession of the default session.
func (o *Orchestrator) Clear(ctx context.Context, pid string) (ClearResult, error) {
	return o.ClearSession(ctx, pid, "")
}

// ClearSession tidies one main session ("": the default): a new main session follows it, with its own root
// agent, the old one's workspace and memory mode, and a carry-over of at most CarryOverTokens (a summary of the
// session written now, the open tasks' titles, a pointer to recall the rest) as the first thing its history
// holds; the new session is the default when the old one was. The old session keeps its conversation (it can
// be opened and continued). An ACP orchestrator's process of the old session is ended (its next session gets
// the carry-over as its recap). The session's slot is held meanwhile; ErrTurnInProgress while it runs a turn.
func (o *Orchestrator) ClearSession(ctx context.Context, pid, sid string) (ClearResult, error) {
	if o.baseCtx.Err() != nil {
		return ClearResult{}, ErrShuttingDown
	}
	db, err := o.store.Get(ctx, pid)
	if err != nil {
		return ClearResult{}, err
	}
	if sid, err = o.mainSession(ctx, db, sid); err != nil {
		return ClearResult{}, err
	}
	key := skey(pid, sid)
	turnCtx, cancel := context.WithCancel(o.baseCtx)
	defer cancel()
	if o.ActiveSession(pid, sid) || !o.claim(key, cancel) {
		return ClearResult{}, ErrTurnInProgress
	}
	// Session announcements wait until the slot is released: while the clear holds it the session reads as
	// Active, and the new session would be announced as "working" with nothing running (decision 95 d).
	var announce []func()
	next := sid
	defer func() {
		// A message sent meanwhile was queued: start it now.
		o.release(key)
		for _, f := range announce {
			f()
		}
		o.qmu.Lock()
		defer o.qmu.Unlock()
		o.startNext(db, sid)
		if next != sid {
			o.startNext(db, next)
		}
	}()
	orch, err := db.RootAgent(ctx, sid)
	if err != nil {
		return ClearResult{}, err
	}
	rt, err := o.newSessionRuntime(ctx, db, sid)
	if err != nil {
		return ClearResult{}, err
	}
	live, err := db.LiveMessages(ctx, orch.ID)
	if err != nil {
		return ClearResult{}, err
	}
	summary, source := o.clearSummary(turnCtx, rt, orch, live)
	o.memoryOf(db).CloseOnClear(ctx) // a finished task closes; an unfinished one is carried by title
	tasks, err := db.Tasks(ctx)
	if err != nil {
		return ClearResult{}, err
	}
	var open []string
	for _, t := range tasks {
		if t.Status == projectstore.TaskOpen {
			open = append(open, t.Title)
		}
	}
	title := sessionTitle(live)
	wasDefault := false
	if info, err := db.SessionInfoOf(ctx, sid); err == nil {
		wasDefault = info.Default
	}
	// The session boundary first: the carry-over belongs to the session it starts. A failure here never undoes the clear.
	var boundary memory.Boundary
	boundaryErr := error(nil)
	if boundary, boundaryErr = o.memoryOf(db).StartSessionFrom(ctx, sid, "clear", memory.Carry{Summary: summary, Source: source}); boundaryErr != nil {
		slog.Warn("memory session boundary failed", "err", boundaryErr)
	}
	target := orch
	if boundaryErr == nil && boundary.SessionID != sid {
		next = boundary.SessionID
		if target, err = db.RootAgent(ctx, next); err != nil {
			return ClearResult{}, err
		}
	}
	c, err := db.AddClear(ctx, target.ID, projectstore.NewID("conv"), carryOver(summary, open), source, title)
	if err != nil {
		return ClearResult{}, err
	}
	if err := db.ResetContext(ctx, target.ID); err != nil {
		return ClearResult{}, err
	}
	isACP := plugins.IsACPRef(rt.models.Orchestrator)
	if isACP {
		if st, ok, err := db.ACPSession(ctx, orch.ID); err == nil && ok {
			// The agent keeps the session being left (on its root and, for older readers, on the session row).
			_ = db.SetSessionACP(ctx, sid, projectstore.SessionACP{Agent: st.PluginAgent, Model: st.Model, SessionID: st.SessionID})
		}
		if next == sid {
			if err := db.DeleteACPSession(ctx, orch.ID); err != nil {
				return ClearResult{}, err
			}
		}
		if s := o.acp.lookup(key); s != nil {
			s.forgetCommands()
		}
		o.resetACPSession(key)
	}
	res := ClearResult{ConversationID: c.ConversationID, UptoMessageID: c.UptoMessageID, At: c.CreatedAt, Title: title, Summary: summary, SummarySource: source}
	if boundaryErr == nil {
		res.SessionID, res.PreviousSessionID = boundary.SessionID, boundary.PreviousID
		if next != sid {
			// A new main session exists (the default when the old one was); the one that ended changed state too.
			newRoot := target
			announce = append(announce, func() {
				bg := context.Background()
				o.hub.Publish(pid, events.AgentCreated, map[string]any{"agent": newRoot, "session_id": next})
				o.publishSession(bg, db, next, true)
				if wasDefault {
					o.defaultChanged(bg, db, sid, next)
				} else {
					o.publishSession(bg, db, sid, false)
				}
			})
		}
	}
	o.hub.Publish(pid, events.ConversationCleared, map[string]any{
		"project_id": pid, "conversation_id": res.ConversationID, "upto_message_id": res.UptoMessageID, "at": res.At,
		"title": title, "summary": summary, "summary_source": source, "session_id": res.SessionID, "previous_session_id": res.PreviousSessionID,
		"agent_id": target.ID,
	})
	o.hub.Publish(pid, events.ContextUpdated, map[string]any{"project_id": pid, "session_id": next})
	if isACP {
		o.hub.Publish(pid, events.SlashCommandsUpdated, map[string]any{"project_id": pid})
	}
	return res, nil
}

// clearSummary writes the summary of the session being cleared: the model's (built-in loop) or
// the agent's (ACP, asked in its live session), else one built from what is stored.
func (o *Orchestrator) clearSummary(ctx context.Context, rt *runtime, orch projectstore.Agent, live []projectstore.Message) (string, string) {
	if len(live) == 0 {
		return "", SummaryStored
	}
	if rt.isACPOrchestrator() {
		if text, ok := o.agentSummary(ctx, rt); ok {
			return text, SummaryAgent
		}
		return storedSummary(rt.latestSummary(ctx, orch.ID), live, true), SummaryStored
	}
	if o.builtinOff() == "" {
		if history, err := rt.loadHistory(ctx, orch.ID); err == nil {
			if text, err := o.summarize(ctx, rt, orch.ID, "summary", clearPrompt, history); err == nil {
				return text, SummaryModel
			}
		}
	}
	return storedSummary(rt.latestSummary(ctx, orch.ID), live, false), SummaryStored
}

// clearCarryOver is the carry-over of the agent's newest clear ("" when its newest compaction row is not one).
func (rt *runtime) clearCarryOver(ctx context.Context, agentID string) string {
	if c, ok, err := rt.db.LatestCompaction(ctx, agentID); err == nil && ok && c.Cleared {
		return c.Summary
	}
	return ""
}

// latestSummary is the newest compaction summary of the agent ("" when none).
func (rt *runtime) latestSummary(ctx context.Context, agentID string) string {
	if c, ok, err := rt.db.LatestCompaction(ctx, agentID); err == nil && ok {
		return c.Summary
	}
	return ""
}

// summaryCollector is the handler of the one prompt that asks an agent for its summary: it keeps the
// text and answers nothing else.
type summaryCollector struct{ text strings.Builder }

func (c *summaryCollector) AgentText(_ context.Context, t string)              { c.text.WriteString(t) }
func (c *summaryCollector) ToolCall(context.Context, acp.ToolCall)             {}
func (c *summaryCollector) ToolCallUpdate(context.Context, acp.ToolCallUpdate) {}
func (c *summaryCollector) Usage(context.Context, acp.Usage)                   {}
func (c *summaryCollector) RequestPermission(context.Context, acp.PermissionRequest) string {
	return ""
}
func (c *summaryCollector) ReadTextFile(context.Context, acp.ReadTextFileParams) (string, error) {
	return "", fmt.Errorf("not available while a session is being cleared")
}
func (c *summaryCollector) WriteTextFile(context.Context, acp.WriteTextFileParams) error {
	return fmt.Errorf("not available while a session is being cleared")
}

// agentSummary asks the live ACP session for the summary (one prompt, agentSummaryTimeout, not
// a user turn: nothing is stored). It never starts a session.
func (o *Orchestrator) agentSummary(ctx context.Context, rt *runtime) (string, bool) {
	s := o.acp.lookup(rt.key())
	if s == nil {
		return "", false
	}
	s.mu.Lock()
	if !s.aliveLocked() || s.sessID == "" || s.busy {
		s.mu.Unlock()
		return "", false
	}
	client, sessID := s.client, s.sessID
	s.busy = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.busy, s.lastUsed = false, time.Now()
		s.mu.Unlock()
	}()
	cctx, cancel := context.WithTimeout(ctx, agentSummaryTimeout)
	defer cancel()
	h := &summaryCollector{}
	stop, err := client.Prompt(cctx, sessID, clearAgentPrompt, h)
	text := strings.TrimSpace(rt.redact(h.text.String()))
	return text, err == nil && stop == acp.StopEndTurn && text != ""
}

// sessionTitle names a session by its first request.
func sessionTitle(live []projectstore.Message) string {
	for _, m := range live {
		if t := messageText(m); m.Role == "user" && t != "" {
			return oneLineOf(t, 60)
		}
	}
	return "empty session"
}

// storedSummary builds a summary without a model: the newest compaction summary, then the last
// three requests (with the start of their final answer when withAnswers).
func storedSummary(prev string, live []projectstore.Message, withAnswers bool) string {
	type exchange struct{ ask, answer string }
	var ex []exchange
	for _, m := range live {
		switch t := messageText(m); {
		case m.Role == "user" && t != "":
			ex = append(ex, exchange{ask: oneLineOf(t, 120)})
		case m.Role == "assistant" && t != "" && len(ex) > 0:
			ex[len(ex)-1].answer = oneLineOf(t, 200)
		}
	}
	if len(ex) > 3 {
		ex = ex[len(ex)-3:]
	}
	var b strings.Builder
	if p := strings.TrimSpace(prev); p != "" {
		b.WriteString("Earlier summary: " + clip(p, 700) + "\n")
	}
	b.WriteString("Last requests:\n")
	for _, e := range ex {
		b.WriteString("- " + e.ask)
		if withAnswers && e.answer != "" {
			b.WriteString(" -> " + e.answer)
		}
		b.WriteString("\n")
	}
	return strings.TrimSpace(b.String())
}

// carryOver is what the next session starts from: the summary, the titles of the open tasks and
// the pointer to the rest, within CarryOverTokens.
func carryOver(summary string, openTasks []string) string {
	const head = "[Carried over from the previous session, which was cleared; you have no other memory of it]\nSummary:\n"
	const tail = "\nThe rest is stored: memory_search finds earlier messages and recall_message returns one word for word."
	var tasks string
	if len(openTasks) > 0 {
		var b strings.Builder
		b.WriteString("\nOpen tasks:")
		for i, t := range openTasks {
			if i == maxCarryTasks {
				fmt.Fprintf(&b, "\n- ... and %d more", len(openTasks)-i)
				break
			}
			b.WriteString("\n- " + oneLineOf(t, 80))
		}
		tasks = b.String()
	}
	room := CarryOverTokens*4 - len(head) - len(tasks) - len(tail)
	if len(summary) > room {
		summary = clip(summary, max(room, 0))
	}
	return head + summary + tasks + tail
}

// CompactViaAgent runs /compact on an ACP orchestrator that advertises a command named
// compact: the command is sent to the agent as a turn and the stored message is returned.
// sent is false when the orchestrator is not such an agent (the caller compacts itself, or
// refuses with the reason Compact gives). ErrTurnInProgress while a turn runs.
func (o *Orchestrator) CompactViaAgent(ctx context.Context, pid string) (msg projectstore.Message, sent bool, err error) {
	return o.CompactViaAgentSession(ctx, pid, "")
}

// CompactViaAgentSession is CompactViaAgent for one main session ("": the default).
func (o *Orchestrator) CompactViaAgentSession(ctx context.Context, pid, sid string) (msg projectstore.Message, sent bool, err error) {
	db, err := o.store.Get(ctx, pid)
	if err != nil {
		return msg, false, err
	}
	if sid, err = o.mainSession(ctx, db, sid); err != nil {
		return msg, false, err
	}
	rt, err := o.newSessionRuntime(ctx, db, sid)
	if err != nil {
		return msg, false, err
	}
	if !rt.isACPOrchestrator() || (!o.agentCommandNamed(rt, "compact") && !retryingFailedCompact(ctx, db, sid)) {
		return msg, false, nil
	}
	msg, err = o.StartWith(ctx, pid, "/compact", StartOpts{SessionID: sid, Command: "compact"})
	return msg, err == nil, err
}

func retryingFailedCompact(ctx context.Context, db *projectstore.DB, sid string) bool {
	orch, err := db.RootAgent(ctx, sid)
	if err != nil {
		return false
	}
	failed := orch.Status == projectstore.StatusFailed ||
		(orch.Error != nil && *orch.Error != "" && !strings.HasPrefix(*orch.Error, "warning:"))
	if !failed {
		return false
	}
	last, err := db.LastMessage(ctx, orch.ID)
	return err == nil && last.Role == "user" && last.SessionID == sid && last.Command == "compact"
}
