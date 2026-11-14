package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/ndolinschi/Octo/apps/harness/internal/activity"
	"net/http"
	"slices"
	"strings"

	"github.com/anthropics/anthropic-sdk-go/v2"
	"github.com/anthropics/anthropic-sdk-go/v2/option"
	"golang.org/x/sync/errgroup"

	"github.com/ndolinschi/Octo/apps/harness/internal/router"
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
	// Router, when it detected an Octo router, adds Hints to every request and
	// supplies the served model, tier, trigger and cost of every response.
	Router *router.Router
	Hints  router.Hints
	// Gate, when set, is checked before every request; its error stops the loop.
	Gate func(ctx context.Context) error
	// Temperature, when set, is sent as the request's temperature (the SDK
	// version in use has no typed field for it). StopSequences end generation.
	Temperature   *float64
	StopSequences []string
	// Steer, when set, is asked at every tool boundary (after a round of tool
	// results is stored, before the next model request) for user messages to
	// inject: each becomes a stored user message of the conversation.
	Steer func(ctx context.Context) []string
	// Clear, when set, replaces old tool results with stubs once a request is
	// past its share of the window, before compaction is considered.
	Clear *ClearPolicy
	// OutputCap, when set, is asked before every request for the most output
	// tokens the remaining budget can buy (0: no limit); inputTokens estimates
	// the request's input. A response that stops at a limit it set ends the
	// loop: its text is stored cut short and BudgetCut's error is returned.
	OutputCap func(ctx context.Context, inputTokens func() int64) int64
	BudgetCut func(ctx context.Context) error
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
	params.StopSequences = l.StopSequences
	if !l.NoPromptCaching {
		markStaticPrefix(&params)
	}

	var res Result
	messages := slices.Clone(history)
	for turn := 1; turn <= maxTurns; turn++ {
		if err := ctx.Err(); err != nil {
			return res, err
		}
		if l.Gate != nil {
			if err := l.Gate(ctx); err != nil {
				return res, err
			}
		}
		if l.Clear != nil {
			sys, tl := 0, 0
			if len(params.System) > 0 {
				sys = len(params.System[0].Text)
			}
			if raw, err := json.Marshal(params.Tools); err == nil {
				tl = len(raw)
			}
			var n int
			if messages, n = l.Clear.Apply(sys, tl, messages); n > 0 {
				if obs, ok := l.Sink.(ClearObserver); ok {
					obs.Cleared(n)
				}
			}
		}
		params.Messages = messages
		send := params
		if !l.NoPromptCaching {
			// Marked on a copy: the breakpoint moves every turn and must never
			// reach the stored history.
			send.Messages = withMessageBreakpoint(messages)
		}
		capped := false
		if l.OutputCap != nil && l.BudgetCut != nil {
			if c := l.OutputCap(ctx, func() int64 { return estimateInput(send) }); c > 0 && c < send.MaxTokens {
				send.MaxTokens, capped = c, true
			}
		}
		l.activity(activity.Thinking, "Thinking", "")
		resp, routed, err := l.request(ctx, send)
		if err != nil {
			return res, err
		}
		u := l.usageOf(ctx, resp, routed)
		res.Usage.add(u)
		l.Sink.Usage(u)

		summary, isCompaction, err := compactionSummary(routed.Trigger, resp.RawJSON())
		if err != nil {
			return res, err
		}
		if isCompaction {
			if messages, err = l.compact(ctx, summary); err != nil {
				return res, err
			}
			continue
		}

		toolUses, textParts := collectAssistant(resp.Content)
		if capped && resp.StopReason == anthropic.StopReasonMaxTokens {
			// The budget's cap cut the answer: keep its text (a tool call cut in the middle is dropped) and stop.
			res.Text = strings.Join(textParts, "")
			if strings.TrimSpace(res.Text) != "" {
				if err := l.storeStopped(ctx, anthropic.NewAssistantMessage(anthropic.NewTextBlock(res.Text))); err != nil {
					return res, err
				}
			}
			return res, l.BudgetCut(ctx)
		}
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
		if l.Steer != nil {
			for _, text := range l.Steer(ctx) {
				steered := anthropic.NewUserMessage(anthropic.NewTextBlock(text))
				if err := l.Sink.Message(ctx, "user", steered); err != nil {
					return res, err
				}
				messages = append(messages, steered)
			}
		}
	}
	return res, ErrMaxTurns
}

func (l *Loop) storeStopped(ctx context.Context, msg anthropic.MessageParam) error {
	if s, ok := l.Sink.(StoppedSink); ok {
		return s.StoppedMessage(ctx, "assistant", msg)
	}
	return l.Sink.Message(ctx, "assistant", msg)
}

// estimateInput is a rough count of a request's input tokens (4 bytes a token
// of its JSON): enough to price the input of a request before it is sent.
func estimateInput(p anthropic.MessageNewParams) int64 {
	n := 0
	for _, part := range []any{p.System, p.Tools, p.Messages} {
		if raw, err := json.Marshal(part); err == nil {
			n += len(raw)
		}
	}
	return int64(n / 4)
}

func (l *Loop) activity(kind, label, toolID string) {
	if s, ok := l.Sink.(ActivitySink); ok {
		s.Activity(kind, label, toolID)
	}
}

func (l *Loop) call(ctx context.Context, params anthropic.MessageNewParams, opts []option.RequestOption, httpResp **http.Response) (anthropic.Message, error) {
	if l.Stream {
		return l.streamMessage(ctx, params, opts, httpResp)
	}
	full, err := l.Client.Messages.New(ctx, params, opts...)
	if err != nil {
		return anthropic.Message{}, err
	}
	return *full, nil
}

func (l *Loop) streamMessage(ctx context.Context, params anthropic.MessageNewParams, opts []option.RequestOption, httpResp **http.Response) (anthropic.Message, error) {
	stream := l.Client.Messages.NewStreaming(ctx, params, opts...)
	defer stream.Close()
	if httpResp != nil && *httpResp != nil && (*httpResp).StatusCode < 400 &&
		(*httpResp).Header.Get(router.HeaderTrigger) == router.TriggerCompact {
		// A router compaction is a JSON body even when a stream was asked for.
		return readJSONMessage((*httpResp).Body)
	}
	var message anthropic.Message
	wrote := false
	for stream.Next() {
		event := stream.Current()
		if e, ok := event.AsAny().(anthropic.ContentBlockDeltaEvent); ok {
			if delta, ok := e.Delta.AsAny().(anthropic.TextDelta); ok && delta.Text != "" {
				if !wrote {
					wrote = true
					l.activity(activity.Text, "Writing", "")
				}
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
			l.activity(activity.Tool, activity.ForTool(tu.Name, tu.Input), tu.ID)
			if s, ok := l.Sink.(ToolInputSink); ok {
				s.ToolInput(tu.ID, tu.Name, tu.Input)
			}
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
	output, isError, err := CallTool(ctx, reg, tu.Name, tu.Input, lim)
	if err != nil {
		return anthropic.ContentBlockParamUnion{}, false, err
	}
	return anthropic.NewToolResultBlock(tu.ID, output, isError), isError, nil
}

// CallTool runs one registered tool the way the loop does: an unknown name is
// an error result, the handler's output is capped by lim, and a non-nil error
// (a failure that must stop the turn, such as a reached budget) is returned
// as is. Tool calls that reach the harness some other way (an ACP agent over
// MCP) go through this too, so they share the loop's handlers and limits.
func CallTool(ctx context.Context, reg *tools.Registry, name string, input json.RawMessage, lim tools.Limits) (output string, isError bool, err error) {
	def, ok := reg.Get(name)
	if !ok {
		return fmt.Sprintf("unknown tool %q", name), true, nil
	}
	output, isError, err = def.Handle(ctx, input)
	if err != nil {
		return "", false, err
	}
	return lim.CapResult(output), isError, nil
}

func cmpOr(v, def int64) int64 {
	if v == 0 {
		return def
	}
	return v
}
