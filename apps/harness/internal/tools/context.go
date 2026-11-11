package tools

import "context"

type toolUseKey struct{}

func WithToolUseID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, toolUseKey{}, id)
}

func ToolUseID(ctx context.Context) string {
	id, _ := ctx.Value(toolUseKey{}).(string)
	return id
}
