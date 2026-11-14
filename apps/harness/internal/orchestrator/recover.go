package orchestrator

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// RecoverInterrupted closes the turn a previous process left running in the
// project (it crashed, was killed or the machine went down) before the store
// settles the agents' rows (projectstore.DB.RecoverInterrupted), so that the
// transcript and the next request see the turn ended rather than dangling:
//
//   - the text each running agent was streaming, as last checkpointed
//     (projectstore/partials.go), becomes its assistant message flagged
//     stopped, after its tool calls left without a result get the interruption
//     result (interruptedResult), the way a stop closes them;
//   - the orchestrator's row is idle with the TurnInterrupted error and hint
//     (a failed turn's row, so the client offers Retry) and the turn's end as
//     finished_at;
//   - the exchange is recorded failed and interrupted, with the request, what
//     had been written and the time from the request to the last sign of life
//     of the turn (what it last wrote, or keepAlive's last beat), not to the
//     restart.
//
// Nothing runs and nothing is published to a client (there is none yet). The
// turn's memory digest is not run: it would call a model at start.
func (o *Orchestrator) RecoverInterrupted(ctx context.Context, db *projectstore.DB) error {
	partials, err := db.TakePartials(ctx)
	if err != nil {
		return err
	}
	alive, err := db.TakeTurnAlive(ctx)
	if err != nil {
		return err
	}
	agents, err := db.Agents(ctx)
	if err != nil {
		return err
	}
	rt := &runtime{o: o, db: db}
	var orch *projectstore.Agent
	running := []projectstore.Agent{}
	lastAt := map[string]string{} // the newest message of each running agent, before anything is added
	end := ""
	for i, a := range agents {
		if a.Status != projectstore.StatusRunning {
			continue
		}
		if a.ParentID == nil {
			orch = &agents[i]
		}
		running = append(running, a)
		if m, err := db.LastMessage(ctx, a.ID); err == nil {
			lastAt[a.ID] = m.CreatedAt
			end = max(end, m.CreatedAt)
		}
	}
	if len(running) == 0 {
		return nil
	}
	for _, a := range running {
		if err := rt.repairDangling(ctx, a.ID); err != nil {
			return err
		}
	}
	for _, p := range partials {
		last, ok := lastAt[p.AgentID]
		if !ok && !isRunning(running, p.AgentID) {
			continue // the agent had finished: its message was stored and only the cleanup was lost
		}
		if ok && p.UpdatedAt <= last {
			continue // older than the agent's last message: that message holds it
		}
		text := rt.redact(p.Text)
		if strings.TrimSpace(text) == "" {
			continue
		}
		sink := &agentSink{rt: rt, agentID: p.AgentID}
		if _, err := sink.store(ctx, "assistant", anthropic.NewAssistantMessage(anthropic.NewTextBlock(text)), true); err != nil {
			return err
		}
		end = max(end, p.UpdatedAt)
	}
	if orch == nil {
		return nil
	}
	req, ok := interruptedRequest(ctx, db, *orch)
	if !ok {
		return nil
	}
	end = max(end, req.CreatedAt)
	if alive > end {
		end = alive // still at work when it last said so (a long tool call writes nothing)
	}
	p := usererr.TurnInterrupted()
	idle := projectstore.StatusIdle
	patch := projectstore.AgentPatch{Status: &idle, Error: &p.Message, ErrorHint: &p.Hint, FinishedAt: &end}
	if _, err := db.UpdateAgent(ctx, orch.ID, patch); err != nil {
		return err
	}
	rt.turnID, rt.request = req.ID, messageText(req)
	ended, _ := time.Parse(time.RFC3339Nano, end)
	o.recordExchangeEnded(rt, orch.ID, projectstore.ExchangeFailed, "", ended, true)
	slog.Info("closed a turn the previous process left running", "project", db.ID(), "request", req.ID, "agents", len(running))
	return nil
}

func isRunning(agents []projectstore.Agent, id string) bool {
	for _, a := range agents {
		if a.ID == id {
			return true
		}
	}
	return false
}

// interruptedRequest is the user message that started the orchestrator's
// running turn: the newest one with text stored when the turn started (a
// message steered into the turn comes after its start; a retried request is
// older than it).
func interruptedRequest(ctx context.Context, db *projectstore.DB, orch projectstore.Agent) (projectstore.Message, bool) {
	msgs, err := db.Messages(ctx, orch.ID)
	if err != nil {
		return projectstore.Message{}, false
	}
	for i := len(msgs) - 1; i >= 0; i-- {
		m := msgs[i]
		if m.Role != "user" || messageText(m) == "" {
			continue
		}
		if orch.StartedAt != nil && m.CreatedAt > *orch.StartedAt {
			continue
		}
		return m, true
	}
	return projectstore.Message{}, false
}
