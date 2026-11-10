package orchestrator

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/anthropics/anthropic-sdk-go/v2"
)

const interruptedResult = "interrupted: the tool call did not complete"

// loadHistory rebuilds the agent's conversation from storage.
func (rt *runtime) loadHistory(ctx context.Context, agentID string) ([]anthropic.MessageParam, error) {
	stored, err := rt.db.Messages(ctx, agentID)
	if err != nil {
		return nil, err
	}
	history := make([]anthropic.MessageParam, 0, len(stored))
	for _, m := range stored {
		var blocks []anthropic.ContentBlockParamUnion
		if err := json.Unmarshal(m.Raw, &blocks); err != nil {
			return nil, fmt.Errorf("message %d: %w", m.ID, err)
		}
		if len(blocks) == 0 {
			continue
		}
		if m.Role == "assistant" {
			history = append(history, anthropic.NewAssistantMessage(blocks...))
		} else {
			history = append(history, anthropic.NewUserMessage(blocks...))
		}
	}
	return history, nil
}

// repairDangling closes a trailing assistant message whose tool calls never got
// results (cancel, crash) with synthetic error results, so the next user
// message keeps the thread valid. Call it before appending that message.
func (rt *runtime) repairDangling(ctx context.Context, agentID string) error {
	stored, err := rt.db.Messages(ctx, agentID)
	if err != nil || len(stored) == 0 {
		return err
	}
	last := stored[len(stored)-1]
	if last.Role != "assistant" {
		return nil
	}
	var results []anthropic.ContentBlockParamUnion
	for _, b := range last.Content {
		if b.Type == "tool_use" && b.ID != nil {
			results = append(results, anthropic.NewToolResultBlock(*b.ID, interruptedResult, true))
		}
	}
	if len(results) == 0 {
		return nil
	}
	sink := &agentSink{rt: rt, agentID: agentID}
	return sink.Message(ctx, "user", anthropic.NewUserMessage(results...))
}
