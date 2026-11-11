package orchestrator

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/ndolinschi/Octo/apps/harness/internal/agent"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// agentSink persists an agent's messages and turns loop activity into events.
type agentSink struct {
	rt      *runtime
	agentID string
	// source labels usage rows; empty means the Messages API.
	source string
}

func (s *agentSink) Message(ctx context.Context, role string, msg anthropic.MessageParam) error {
	body, err := json.Marshal(agent.ContentOf(msg))
	if err != nil {
		return err
	}
	body = s.rt.o.secrets.RedactBytes(s.rt.pid(), body) // last guard: no stored secret reaches a transcript row
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

func (s *agentSink) Usage(u agent.Usage) { s.record(u, nil) }

// record stores one usage row (and totals), plus the context window when known.
func (s *agentSink) record(u agent.Usage, w *projectstore.ContextWindow) {
	source := s.source
	if source == "" {
		source = projectstore.SourceAPI
	}
	c, cancel := dbCtx(context.Background())
	defer cancel()
	a, err := s.rt.db.RecordUsage(c, projectstore.UsageRecord{
		AgentID: s.agentID, Model: u.Model, Source: source,
		InputTokens: u.InputTokens, OutputTokens: u.OutputTokens,
		CacheReadTokens: u.CacheReadTokens, CacheWriteTokens: u.CacheWriteTokens,
		CostUSD: u.CostUSD, Context: w,
		ServedModel: u.ServedModel, Tier: u.Tier, RouteTrigger: u.Trigger, RouterRequestID: u.RequestID,
		CostEstimated: u.CostEstimated, FlatRate: u.FlatRate,
	})
	if err != nil {
		s.rt.logErr("record usage", err)
		return
	}
	s.rt.publishAgent(events.AgentUpdated, a)
}

// Compacted stores a router-made summary as the agent's compacted history.
func (s *agentSink) Compacted(ctx context.Context, summary string) error {
	c, cancel := dbCtx(ctx)
	defer cancel()
	comp, err := s.rt.db.AddCompaction(c, s.agentID, summary)
	if err != nil {
		return err
	}
	s.rt.publish(events.AgentCompacted, map[string]any{
		"agent_id": s.agentID, "upto_message_id": comp.UptoMessageID,
		"summary_tokens": comp.SummaryTokens(), "at": comp.CreatedAt,
	})
	return nil
}

// setContext stores the context window without writing a usage row.
func (s *agentSink) setContext(w projectstore.ContextWindow) {
	c, cancel := dbCtx(context.Background())
	defer cancel()
	a, err := s.rt.db.SetContext(c, s.agentID, w)
	if err != nil {
		s.rt.logErr("set context", err)
		return
	}
	s.rt.publishAgent(events.AgentUpdated, a)
}

func (rt *runtime) logErr(what string, err error) {
	slog.Error(what, "project", rt.pid(), "err", err)
}
