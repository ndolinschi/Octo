package orchestrator

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/memory"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// recordExchange writes the finished turn into the project's sessions (memory
// M4): the request as typed, the last assistant text of the turn (not the tool
// chatter; the stored messages are read so a failed or stopped turn keeps what
// it had said), when, how long, who answered, files changed, sub-agents,
// tokens and cost. It runs once per turn for every outcome; a failure only logs.
func (o *Orchestrator) recordExchange(rt *runtime, orchID string, status projectstore.AgentStatus, replyText string, problem *usererr.Error) {
	o.recordExchangeEnded(rt, orchID, exchangeStatus(status), replyText, time.Time{}, false, problem)
}

// recordExchangeEnded is recordExchange with the turn's end (zero: now) and
// whether the harness stopped while it ran (RecoverInterrupted). problem is
// the failure of a failed turn, kept on the exchange (code, message, hint).
func (o *Orchestrator) recordExchangeEnded(rt *runtime, orchID, status, replyText string, end time.Time, interrupted bool, problem *usererr.Error) {
	if rt.turnID == 0 {
		return
	}
	ctx, cancel := dbCtx(context.Background())
	defer cancel()
	request, _, _, started, err := rt.db.MessageText(ctx, rt.turnID)
	if err != nil {
		rt.logErr("record exchange", err)
		return
	}
	if strings.TrimSpace(request) == "" {
		request = rt.request
	}
	begin, _ := time.Parse(time.RFC3339Nano, started)
	if end.IsZero() {
		end = time.Now()
	}
	answer, answerID := replyText, int64(0)
	if msgs, err := rt.db.Messages(ctx, orchID); err == nil {
		for i := len(msgs) - 1; i >= 0 && msgs[i].ID > rt.turnID; i-- {
			if t := messageText(msgs[i]); msgs[i].Role == "assistant" && t != "" {
				answer, answerID = t, msgs[i].ID
				break
			}
		}
	}
	in := memory.ExchangeInput{
		TurnID: rt.turnID, MessageID: answerID, Request: request, Answer: answer, StartedAt: begin, Duration: max(end.Sub(begin)-o.approvals.TakeWaited(rt.pid(), rt.turnID), 0),
		Status: status, TaskID: rt.currentTask(), Files: []string{}, Agents: []string{}, Interrupted: interrupted,
	}
	if problem != nil && status == projectstore.ExchangeFailed {
		in.Error = &projectstore.ExchangeError{Code: problem.Code, Message: problem.Message, Hint: problem.Hint}
	}
	if a, err := rt.db.Agent(ctx, orchID); err == nil {
		in.Model = a.Model
	}
	if files, err := rt.db.ChangedPaths(ctx, rt.turnID); err == nil {
		in.Files = files
	}
	if agents, err := rt.db.SubAgentTitlesIn(ctx, started, rt.sessionID); err == nil {
		in.Agents = agents
	}
	if tok, cost, err := rt.db.TurnUsageIn(ctx, started, rt.sessionID); err == nil {
		in.Tokens, in.CostUSD = tok, cost
	}
	if _, err := rt.memory().RecordExchange(ctx, in); err != nil {
		rt.logErr("record exchange", err)
	}
}

// rewindBoundary starts a new session when a rewind cut every request of the
// conversation (memory M4, rule 2). The exchanges stay as the record.
func (o *Orchestrator) rewindBoundary(ctx context.Context, db *projectstore.DB, orchID string) {
	msgs, err := db.Messages(ctx, orchID)
	if err != nil {
		return
	}
	for _, m := range msgs {
		if m.Role == "user" && messageText(m) != "" {
			return
		}
	}
	sid, err := db.SessionOfAgentRow(ctx, orchID)
	if err != nil {
		return
	}
	b, err := o.memoryOf(db).StartSessionFrom(ctx, sid, "rewind")
	if err != nil {
		slog.Warn("memory session boundary failed", "err", err)
		return
	}
	if b.SessionID != sid {
		// The rewound conversation stays in its session; the next request starts the new one.
		if root, err := db.RootAgent(ctx, b.SessionID); err == nil {
			o.hub.Publish(db.ID(), events.AgentCreated, map[string]any{"agent": root, "session_id": b.SessionID})
		}
		o.publishSession(ctx, db, b.SessionID, true)
		if info, err := db.SessionInfoOf(ctx, b.SessionID); err == nil && info.Default {
			o.defaultChanged(ctx, db, sid, b.SessionID)
		} else {
			o.publishSession(ctx, db, sid, false)
		}
	}
}

func exchangeStatus(s projectstore.AgentStatus) string {
	switch s {
	case projectstore.StatusCompleted:
		return projectstore.ExchangeCompleted
	case projectstore.StatusCancelled:
		return projectstore.ExchangeStopped
	}
	return projectstore.ExchangeFailed
}
