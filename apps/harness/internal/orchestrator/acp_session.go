package orchestrator

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"sync"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
	"github.com/ndolinschi/Octo/apps/harness/internal/agent"
)

const toolNameFallback = "tool"

// acpSession is the acp.Handler for one ACP sub-agent: it turns the agent's
// updates into events and an SDK-shaped persisted transcript.
type acpSession struct {
	rt      *runtime
	sink    *agentSink
	agentID string
	label   string

	mu       sync.Mutex
	pending  strings.Builder
	all      []string
	tail     string
	open     map[string]bool
	seen     map[string]bool
	lastUsed int64
	done     bool
}

func newACPSession(rt *runtime, agentID, label string) *acpSession {
	return &acpSession{
		rt: rt, sink: &agentSink{rt: rt, agentID: agentID}, agentID: agentID, label: label,
		open: map[string]bool{}, seen: map[string]bool{},
	}
}

func (s *acpSession) AgentText(_ context.Context, text string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.done {
		return
	}
	s.pending.WriteString(text)
	s.sink.TextDelta(text)
}

func (s *acpSession) ToolCall(ctx context.Context, call acp.ToolCall) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.done {
		return
	}
	s.flushLocked(ctx)
	s.startLocked(ctx, call)
	if call.Status.Terminal() {
		s.finishToolLocked(ctx, call)
	}
}

func (s *acpSession) ToolCallUpdate(ctx context.Context, up acp.ToolCallUpdate) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.done {
		return
	}
	if !s.seen[up.ID] {
		s.flushLocked(ctx)
		s.startLocked(ctx, up)
	}
	if up.Status.Terminal() && s.open[up.ID] {
		s.finishToolLocked(ctx, up)
	}
}

func (s *acpSession) Usage(_ context.Context, u acp.Usage) {
	s.mu.Lock()
	delta := u.Used - s.lastUsed
	s.lastUsed = u.Used
	s.mu.Unlock()
	if delta > 0 {
		s.sink.Usage(agent.Usage{InputTokens: delta})
	}
}

func (s *acpSession) RequestPermission(_ context.Context, req acp.PermissionRequest) string {
	opt, ok := req.FirstOption(acp.AllowOnce, acp.AllowAlways)
	if !ok {
		slog.Warn("acp permission: no allow option offered; cancelling",
			"project", s.rt.pid(), "agent", s.label, "tool", req.ToolCall.Title)
		return ""
	}
	slog.Info("acp permission auto-approved",
		"project", s.rt.pid(), "agent", s.label, "tool", req.ToolCall.Title, "option", opt.Name, "kind", opt.Kind)
	return opt.ID
}

// finish flushes trailing text and closes tool calls the agent left open.
func (s *acpSession) finish(ctx context.Context, failed bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.done {
		return
	}
	s.flushLocked(ctx)
	reason := "the agent ended its turn before this tool call finished"
	if failed {
		reason = "the agent stopped before this tool call finished"
	}
	for id := range s.open {
		s.resultLocked(ctx, id, reason, true)
	}
	s.done = true
}

// finalText is the last assistant text segment, else all text joined.
func (s *acpSession) finalText() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if t := strings.TrimSpace(s.tail); t != "" {
		return t
	}
	return strings.TrimSpace(strings.Join(s.all, "\n\n"))
}

func (s *acpSession) flushLocked(ctx context.Context) {
	text := s.pending.String()
	s.pending.Reset()
	if strings.TrimSpace(text) == "" {
		return
	}
	s.all = append(s.all, text)
	s.tail = text
	s.persist(ctx, "assistant", anthropic.NewAssistantMessage(anthropic.NewTextBlock(text)))
}

func (s *acpSession) startLocked(ctx context.Context, call acp.ToolCall) {
	name := call.Kind
	if name == "" {
		name = toolNameFallback
	}
	input := map[string]any{"title": call.Title}
	if len(call.RawInput) > 0 && string(call.RawInput) != "null" {
		input["raw_input"] = json.RawMessage(call.RawInput)
	}
	if len(call.Locations) > 0 {
		input["locations"] = call.Locations
	}
	s.seen[call.ID] = true
	s.open[call.ID] = true
	s.tail = ""
	s.persist(ctx, "assistant", anthropic.NewAssistantMessage(anthropic.NewToolUseBlock(call.ID, input, name)))
	s.sink.ToolStarted(call.ID, name)
}

func (s *acpSession) finishToolLocked(ctx context.Context, up acp.ToolCallUpdate) {
	text := flattenContent(up.Content)
	if text == "" {
		text = string(up.Status)
	}
	s.resultLocked(ctx, up.ID, text, up.Status == acp.ToolFailed)
}

func (s *acpSession) resultLocked(ctx context.Context, id, text string, isErr bool) {
	delete(s.open, id)
	s.persist(ctx, "user", anthropic.NewUserMessage(anthropic.NewToolResultBlock(id, capText(text), isErr)))
	s.sink.ToolFinished(id, isErr)
}

func (s *acpSession) persist(ctx context.Context, role string, msg anthropic.MessageParam) {
	if err := s.sink.Message(ctx, role, msg); err != nil {
		s.rt.logErr("persist acp message", err)
	}
}
