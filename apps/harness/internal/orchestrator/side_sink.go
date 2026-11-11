package orchestrator

import (
	"context"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/ndolinschi/Octo/apps/harness/internal/agent"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// sideSink streams a side question's text as events and records its usage with
// role "side". Its messages are not stored: only the final answer is, by
// runSide, in side_messages.
type sideSink struct {
	rt      *runtime
	sideID  string
	agentID string
}

func (s *sideSink) Message(context.Context, string, anthropic.MessageParam) error { return nil }

func (s *sideSink) TextDelta(text string) {
	s.rt.publish(events.SideDelta, map[string]any{"side_id": s.sideID, "text": text})
}

func (s *sideSink) ToolStarted(string, string) {}
func (s *sideSink) ToolFinished(string, bool)  {}

func (s *sideSink) Usage(u agent.Usage) {
	c, cancel := dbCtx(context.Background())
	defer cancel()
	_, err := s.rt.db.RecordUsage(c, projectstore.UsageRecord{
		AgentID: s.agentID, Role: projectstore.RoleSide, Model: u.Model, Source: projectstore.SourceAPI,
		InputTokens: u.InputTokens, OutputTokens: u.OutputTokens,
		CacheReadTokens: u.CacheReadTokens, CacheWriteTokens: u.CacheWriteTokens,
		CostUSD: u.CostUSD, ServedModel: u.ServedModel, Tier: u.Tier, RouteTrigger: u.Trigger,
		RouterRequestID: u.RequestID, CostEstimated: u.CostEstimated,
	})
	if err != nil {
		s.rt.logErr("record side usage", err)
	}
}
