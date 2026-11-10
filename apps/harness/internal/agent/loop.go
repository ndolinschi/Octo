package agent

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/anthropics/anthropic-sdk-go/v2"
	"golang.org/x/sync/errgroup"

	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
)

const (
	defaultMaxTurns  = 25
	defaultMaxTokens = 8192
)

var ErrMaxTurns = errors.New("agent: exceeded max turns")

// Loop runs the Messages tool loop over an existing conversation.
type Loop struct {
	Client    anthropic.Client
	Registry  *tools.Registry
	Model     string
	System    string
	MaxTurns  int
	MaxTokens int64
	Stream    bool
	SessionID string
	Sink      Sink
	// NoPromptCaching turns off the cache_control breakpoints (see cache.go),
	// for gateways that reject the field. The zero value caches.
	NoPromptCaching bool
	// Limits cap tool results returned to the model; zero fields mean defaults.
	Limits tools.Limits
}

// Run continues history (which must end with a user message already persisted
// by the caller) until the model answers without tool calls.
func (l *Loop) Run(ctx context.Context, history []anthropic.MessageParam) (Result, error) {
	if l.Registry == nil || l.Sink == nil || l.Model == "" {
		return Result{}, fmt.Errorf("agent: registry, sink and model required")
	}
	maxTurns := l.MaxTurns
	if maxTurns < 1 {
		maxTurns = defaultMaxTurns
	}
	params := anthropic.MessageNewParams{
		Model:     anthropic.Model(l.Model),
		MaxTokens: cmpOr(l.MaxTokens, defaultMaxTokens),
		Tools:     l.Registry.AnthropicTools(),
		Metadata: anthropic.MetadataParam{
			// Octo reads metadata.user_id as JSON {"session_id":"..."} for sticky/budget.
			UserID: anthropic.String(fmt.Sprintf(`{"session_id":%q}`, l.SessionID)),
		},
	}
	if l.System != "" {
		params.System = []anthropic.TextBlockParam{{Text: l.System}}
	}
	if !l.NoPromptCaching {
		markStaticPrefix(&params)
	}

	var res Result
	messages := slices.Clone(history)
	for turn := 1; turn <= maxTurns; turn++ {
		if err := ctx.Err(); err != nil {
			return res, err
		}
		params.Messages = messages
		send := params
		if !l.NoPromptCaching {
			// Marked on a copy: the breakpoint moves every turn and must never
			// reach the stored history.
			send.Messages = withMessageBreakpoint(messages)
		}
		resp, err := l.call(ctx, send)
		if err != nil {
			return res, err
		}
		u := Usage{
			Model:            l.Model,
			InputTokens:      resp.Usage.InputTokens,
			OutputTokens:     resp.Usage.OutputTokens,
			CacheReadTokens:  resp.Usage.CacheReadInputTokens,
			CacheWriteTokens: resp.Usage.CacheCreationInputTokens,
		}
		res.Usage.add(u)
		l.Sink.Usage(u)

		toolUses, textParts := collectAssistant(resp.Content)
		assistantMsg := resp.ToParam()
		if err := l.Sink.Message(ctx, "assistant", assistantMsg); err != nil {
			return res, err
		}
		messages = append(messages, assistantMsg)
		if len(toolUses) == 0 {
			res.Text = strings.Join(textParts, "")
			return res, nil
		}
		if turn >= maxTurns {
			return res, ErrMaxTurns
		}

		blocks, err := l.runTools(ctx, toolUses)
		if err != nil {
			return res, err
		}
		if err := ctx.Err(); err != nil {
			return res, err
		}
		toolUser := anthropic.NewUserMessage(blocks...)
		if err := l.Sink.Message(ctx, "user", toolUser); err != nil {
			return res, err
		}
		messages = append(messages, toolUser)
	}
	return res, ErrMaxTurns
}

func (l *Loop) call(ctx context.Context, params anthropic.MessageNewParams) (anthropic.Message, error) {
	if l.Stream {
		return l.streamMessage(ctx, params)
	}
	full, err := l.Client.Messages.New(ctx, params)
	if err != nil {
		return anthropic.Message{}, err
	}
	return *full, nil
}

func (l *Loop) streamMessage(ctx context.Context, params anthropic.MessageNewParams) (anthropic.Message, error) {
	stream := l.Client.Messages.NewStreaming(ctx, params)
	defer stream.Close()
	var message anthropic.Message
	for stream.Next() {
		event := stream.Current()
		if e, ok := event.AsAny().(anthropic.ContentBlockDeltaEvent); ok {
			if delta, ok := e.Delta.AsAny().(anthropic.TextDelta); ok && delta.Text != "" {
				l.Sink.TextDelta(delta.Text)
			}
		}
		if err := message.Accumulate(event); err != nil {
			return message, err
		}
	}
	return message, stream.Err()
}

// runTools executes tool calls concurrently and returns results in call order.
func (l *Loop) runTools(ctx context.Context, uses []anthropic.ToolUseBlock) ([]anthropic.ContentBlockParamUnion, error) {
	blocks := make([]anthropic.ContentBlockParamUnion, len(uses))
	g, gctx := errgroup.WithContext(ctx)
	for i, tu := range uses {
		g.Go(func() error {
			l.Sink.ToolStarted(tu.ID, tu.Name)
			block, isError, err := dispatchTool(tools.WithToolUseID(gctx, tu.ID), l.Registry, tu, l.Limits)
			if err != nil {
				return err
			}
			blocks[i] = block
			l.Sink.ToolFinished(tu.ID, isError)
			return nil
		})
	}
	if err := g.Wait(); err != nil {
		return nil, err
	}
	return blocks, nil
}

func collectAssistant(content []anthropic.ContentBlockUnion) (toolUses []anthropic.ToolUseBlock, textParts []string) {
	for _, c := range content {
		switch v := c.AsAny().(type) {
		case anthropic.TextBlock:
			textParts = append(textParts, v.Text)
		case anthropic.ToolUseBlock:
			toolUses = append(toolUses, v)
		}
	}
	return toolUses, textParts
}

func dispatchTool(ctx context.Context, reg *tools.Registry, tu anthropic.ToolUseBlock, lim tools.Limits) (anthropic.ContentBlockParamUnion, bool, error) {
	def, ok := reg.Get(tu.Name)
	if !ok {
		return anthropic.NewToolResultBlock(tu.ID, fmt.Sprintf("unknown tool %q", tu.Name), true), true, nil
	}
	output, isError, err := def.Handle(ctx, tu.Input)
	if err != nil {
		return anthropic.ContentBlockParamUnion{}, false, err
	}
	return anthropic.NewToolResultBlock(tu.ID, lim.CapResult(output), isError), isError, nil
}

func cmpOr(v, def int64) int64 {
	if v == 0 {
		return def
	}
	return v
}
