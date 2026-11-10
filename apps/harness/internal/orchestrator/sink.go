package orchestrator

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/ndolinschi/Octo/apps/harness/internal/agent"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
)

// agentSink persists an agent's messages and turns loop activity into events.
type agentSink struct {
	rt      *runtime
	agentID string
}

func (s *agentSink) Message(ctx context.Context, role string, msg anthropic.MessageParam) error {
	body, err := json.Marshal(agent.ContentOf(msg))
	if err != nil {
		return err
	}
	c, cancel := dbCtx(ctx)
	defer cancel()
	stored, err := s.rt.db.AppendMessage(c, s.agentID, role, body)
	if err != nil {
		return err
	}
	s.rt.publish(events.MessageCreated, map[string]any{"message": stored})
	return nil
}

func (s *agentSink) TextDelta(text string) {
	s.rt.publish(events.MessageDelta, map[string]any{"agent_id": s.agentID, "text": text})
}

func (s *agentSink) ToolStarted(id, name string) {
	s.rt.publish(events.ToolStarted, map[string]any{"agent_id": s.agentID, "tool_use_id": id, "name": name})
}

func (s *agentSink) ToolFinished(id string, isError bool) {
	s.rt.publish(events.ToolFinished, map[string]any{"agent_id": s.agentID, "tool_use_id": id, "is_error": isError})
}

func (s *agentSink) Usage(u agent.Usage) {
	c, cancel := dbCtx(context.Background())
	defer cancel()
	a, err := s.rt.db.AddUsage(c, s.agentID, u.InputTokens, u.OutputTokens)
	if err != nil {
		s.rt.logErr("add usage", err)
		return
	}
	s.rt.publishAgent(events.AgentUpdated, a)
}

func (rt *runtime) logErr(what string, err error) {
	slog.Error(what, "project", rt.pid(), "err", err)
}
