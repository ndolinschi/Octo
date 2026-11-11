package acp

import "context"

// Handler receives everything the agent sends during a Run. Methods are
// called one at a time, in the order the agent sent them. ctx is cancelled
// when Run returns, not when Run's own context is cancelled, so handlers can
// still record what an agent does while it winds down.
type Handler interface {
	AgentText(ctx context.Context, text string)
	ToolCall(ctx context.Context, call ToolCall)
	ToolCallUpdate(ctx context.Context, update ToolCallUpdate)
	Usage(ctx context.Context, u Usage)
	// RequestPermission returns the chosen option id; "" answers "cancelled".
	RequestPermission(ctx context.Context, req PermissionRequest) string
	// ReadTextFile returns the (already line-sliced) content, or an error that
	// is sent to the agent as a JSON-RPC error.
	ReadTextFile(ctx context.Context, req ReadTextFileParams) (string, error)
	WriteTextFile(ctx context.Context, req WriteTextFileParams) error
}

// PlanEntry is one line of an agent's plan (session/update "plan").
type PlanEntry struct {
	Content  string `json:"content"`
	Status   string `json:"status"`
	Priority string `json:"priority"`
}

// ThoughtHandler is implemented by handlers that want the agent's reasoning
// (agent_thought_chunk). Without it the chunks are dropped.
type ThoughtHandler interface {
	AgentThought(ctx context.Context, text string)
}

// PlanHandler is implemented by handlers that want plan updates; each carries
// the whole plan.
type PlanHandler interface {
	Plan(ctx context.Context, entries []PlanEntry)
}

// UpdateObserver is told about every session/update the agent sends, of any
// kind (also the ones that are otherwise ignored, like available_commands_update),
// before it is handled: a sign of life.
type UpdateObserver interface {
	UpdateSeen(ctx context.Context, kind string)
}

// PromptUsageHandler is implemented by handlers that want the token usage an
// agent reports with the end of a prompt, when it does.
type PromptUsageHandler interface {
	PromptUsage(ctx context.Context, u PromptUsage)
}
