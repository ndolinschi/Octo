package orchestrator

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/ndolinschi/Octo/apps/harness/internal/agent"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

const interruptedResult = "interrupted: the tool call did not complete"

// loadHistory rebuilds the agent's conversation from storage: the latest
// compaction summary, if any, then the messages stored after it.
func (rt *runtime) loadHistory(ctx context.Context, agentID string) ([]anthropic.MessageParam, error) {
	return rt.loadHistoryWith(ctx, agentID, rt.imageLoader(ctx))
}

// loadHistoryWith is loadHistory with the images of the messages loaded by
// load; a nil loader turns every image into its text placeholder (what a
// summary is made from).
func (rt *runtime) loadHistoryWith(ctx context.Context, agentID string, load imageLoader) ([]anthropic.MessageParam, error) {
	stored, err := rt.db.LiveMessages(ctx, agentID)
	if err != nil {
		return nil, err
	}
	comp, compacted, err := rt.db.LatestCompaction(ctx, agentID)
	if err != nil {
		return nil, err
	}
	history := make([]anthropic.MessageParam, 0, len(stored)+1)
	switch {
	case compacted && comp.Cleared:
		history = append(history, anthropic.NewUserMessage(anthropic.NewTextBlock(comp.Summary))) // the carry-over of a clear
	case compacted:
		history = append(history, agent.SummaryMessage(comp.Summary))
	}
	for _, m := range stored {
		if compacted && m.ID <= comp.UptoMessageID {
			continue
		}
		p, ok, err := messageParamWith(m, load)
		if err != nil {
			return nil, err
		}
		if ok {
			history = append(history, p)
		}
	}
	return history, nil
}

// messageParam converts a stored message to the SDK's form; false for an empty one.
func messageParam(m projectstore.Message) (anthropic.MessageParam, bool, error) {
	return messageParamWith(m, nil)
}

func messageParamWith(m projectstore.Message, load imageLoader) (anthropic.MessageParam, bool, error) {
	var blocks []anthropic.ContentBlockParamUnion
	if err := json.Unmarshal(resolveImages(m.Raw, load), &blocks); err != nil {
		return anthropic.MessageParam{}, false, fmt.Errorf("message %d: %w", m.ID, err)
	}
	if len(blocks) == 0 {
		return anthropic.MessageParam{}, false, nil
	}
	if m.Role == "assistant" {
		return anthropic.NewAssistantMessage(blocks...), true, nil
	}
	return anthropic.NewUserMessage(blocks...), true, nil
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
