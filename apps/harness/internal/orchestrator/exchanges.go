package orchestrator

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/memory"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// recordExchange writes the finished turn into the project's sessions (memory
// M4): the request as typed, the last assistant text of the turn (not the tool
// chatter; the stored messages are read so a failed or stopped turn keeps what
// it had said), when, how long, who answered, files changed, sub-agents,
// tokens and cost. It runs once per turn for every outcome; a failure only logs.
func (o *Orchestrator) recordExchange(rt *runtime, orchID string, status projectstore.AgentStatus, replyText string) {
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
		TurnID: rt.turnID, MessageID: answerID, Request: request, Answer: answer, StartedAt: begin, Duration: time.Since(begin),
		Status: exchangeStatus(status), TaskID: rt.currentTask(), Files: []string{}, Agents: []string{},
	}
	if a, err := rt.db.Orchestrator(ctx); err == nil {
		in.Model = a.Model
	}
	if files, err := rt.db.ChangedPaths(ctx, rt.turnID); err == nil {
		in.Files = files
	}
	if agents, err := rt.db.SubAgentTitles(ctx, started); err == nil {
		in.Agents = agents
	}
	if tok, cost, err := rt.db.TurnUsage(ctx, started); err == nil {
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
	if _, err := o.memoryOf(db).StartSession(ctx, "rewind"); err != nil {
		slog.Warn("memory session boundary failed", "err", err)
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
