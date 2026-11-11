package agent

import (
	"context"
	"encoding/json"

	"github.com/anthropics/anthropic-sdk-go/v2"
)

// Sink receives everything the loop produces. Message is called for every
// message that must be persisted, in conversation order. The other methods may
// be called from concurrent goroutines.
type Sink interface {
	Message(ctx context.Context, role string, msg anthropic.MessageParam) error
	TextDelta(text string)
	ToolStarted(id, name string)
	ToolFinished(id string, isError bool)
	Usage(u Usage)
}

// ActivitySink is implemented by sinks that publish what the agent is doing
// now. The loop calls Activity on every transition: "thinking" before each
// model request, "text" when the answer starts streaming, "tool" when a tool
// starts (label built from its name and arguments).
type ActivitySink interface {
	Activity(kind, label, toolID string)
}

// ToolInputSink is implemented by sinks that want the arguments of a tool call
// as it starts (the loop calls ToolInput right after ToolStarted).
type ToolInputSink interface {
	ToolInput(id, name string, input json.RawMessage)
}

// Compactor is implemented by sinks that keep compaction summaries; the loop
// calls Compacted when an Octo router answered with one (see compactionSummary).
type Compactor interface {
	Compacted(ctx context.Context, summary string) error
}

// Usage is the token usage of one model response. Model is the model the
// request asked for; CostUSD is a source-reported cost, nil when there is none.
// The fields after CostUSD are only set with an Octo router in the path:
// ServedModel is the model that answered, CostEstimated says CostUSD is the
// router's own estimate.
type Usage struct {
	Model            string
	InputTokens      int64
	OutputTokens     int64
	CacheReadTokens  int64
	CacheWriteTokens int64
	CostUSD          *float64

	ServedModel   string
	Tier          string
	Trigger       string
	RequestID     string
	CostEstimated bool
	// FlatRate: CostUSD is a flat-rate agent's own estimate, not money spent.
	FlatRate bool
	// TokensEstimated: the token counts are the harness's estimate (an ACP agent reported none).
	TokensEstimated bool
}

func (u *Usage) add(o Usage) {
	u.InputTokens += o.InputTokens
	u.OutputTokens += o.OutputTokens
	u.CacheReadTokens += o.CacheReadTokens
	u.CacheWriteTokens += o.CacheWriteTokens
}

type Result struct {
	Text  string
	Usage Usage
}

// ContentOf returns the content blocks of a user or assistant message.
func ContentOf(msg anthropic.MessageParam) []anthropic.ContentBlockParamUnion {
	switch {
	case msg.OfUser != nil:
		return msg.OfUser.Content
	case msg.OfAssistant != nil:
		return msg.OfAssistant.Content
	}
	return nil
}
