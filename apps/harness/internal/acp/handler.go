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
