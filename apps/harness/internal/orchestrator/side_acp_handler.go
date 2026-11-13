package orchestrator

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
	"github.com/ndolinschi/Octo/apps/harness/internal/activity"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/files"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/secrets"
)

// sideHandler is the acp.Handler of one side prompt. The side agent may read
// the project and think; the harness refuses every write, command and other
// permission request, and every fs write, whatever the agent's own mode is.
type sideHandler struct {
	rt      *runtime
	sideID  string
	agentID string
	model   string
	flat    bool
	sess    *sideSession

	mu       sync.Mutex
	text     strings.Builder
	stream   *secrets.Stream
	thought  *secrets.Stream
	runes    int64
	reported *acp.PromptUsage
	done     bool
	// refused counts the requests the harness denied.
	refused int
}

func newSideHandler(rt *runtime, sideID, agentID string, t acpTarget, s *sideSession) *sideHandler {
	return &sideHandler{
		rt: rt, sideID: sideID, agentID: agentID, model: t.recorded(), sess: s,
		flat:   t.agent.FlatRateIn(t.processEnv()),
		stream: rt.o.secrets.NewStream(rt.pid()), thought: rt.o.secrets.NewStream(rt.pid()),
	}
}

func (h *sideHandler) activity(kind, label, toolID string) {
	fields := map[string]any{"side_id": h.sideID, "kind": kind, "label": h.rt.redact(label)}
	if toolID != "" {
		fields["tool_use_id"] = toolID
	}
	h.rt.publish(events.SideActivity, fields)
}

func (h *sideHandler) AgentText(_ context.Context, text string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.done {
		return
	}
	h.activity(activity.Text, "Writing", "")
	h.runes += int64(utf8.RuneCountInString(text))
	safe := h.stream.Write(text)
	h.text.WriteString(safe)
	if safe != "" {
		h.rt.publish(events.SideDelta, map[string]any{"side_id": h.sideID, "text": safe})
	}
}

// AgentThought streams the agent's reasoning; it is stored nowhere.
func (h *sideHandler) AgentThought(_ context.Context, text string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.done {
		return
	}
	h.activity(activity.Thinking, "Thinking", "")
	h.runes += int64(utf8.RuneCountInString(text))
	if safe := h.thought.Write(text); safe != "" {
		h.rt.publish(events.SideThinking, map[string]any{"side_id": h.sideID, "text": safe})
	}
}

func (h *sideHandler) toolFields(call acp.ToolCall) map[string]any {
	fields := map[string]any{"side_id": h.sideID, "tool_use_id": call.ID}
	if call.Title != "" {
		fields["title"] = h.rt.redact(call.Title)
	}
	if call.Kind != "" {
		fields["kind"] = call.Kind
	}
	if call.Status != "" {
		fields["status"] = string(call.Status)
	}
	return fields
}

func (h *sideHandler) cwd() string {
	if len(h.rt.folders) > 0 {
		return h.rt.folders[0].Path
	}
	return ""
}

func (h *sideHandler) ToolCall(_ context.Context, call acp.ToolCall) {
	loc := ""
	if len(call.Locations) > 0 {
		loc = call.Locations[0].Path
	}
	h.rt.publish(events.SideTool, h.toolFields(call))
	h.activity(activity.Tool, activity.ForACP(call.Kind, call.Title, loc, h.cwd()), call.ID)
}

func (h *sideHandler) ToolCallUpdate(_ context.Context, up acp.ToolCallUpdate) {
	h.rt.publish(events.SideTool, h.toolFields(up))
	if up.Status.Terminal() {
		h.activity(activity.Thinking, "Thinking", "")
	}
}

// Usage turns the agent's cumulative counters into a usage row of role side.
func (h *sideHandler) Usage(_ context.Context, u acp.Usage) {
	s := h.sess
	s.mu.Lock()
	delta := u.Used - s.usedSeen
	s.usedSeen = u.Used
	var cost *float64
	if c := u.Cost; c != nil && strings.EqualFold(c.Currency, "USD") && c.Amount >= 0 {
		d := c.Amount - s.costSeen
		if d < 0 {
			d = c.Amount
		}
		s.costSeen = c.Amount
		if d != 0 {
			cost = &d
		}
	}
	s.mu.Unlock()
	if delta <= 0 && cost == nil {
		return
	}
	h.record(projectstore.UsageRecord{InputTokens: max(delta, 0), CostUSD: cost, CostEstimated: h.flat && cost != nil})
}

func (h *sideHandler) PromptUsage(_ context.Context, u acp.PromptUsage) {
	h.mu.Lock()
	h.reported = &u
	h.mu.Unlock()
}

func (h *sideHandler) record(r projectstore.UsageRecord) {
	r.AgentID, r.Role, r.Model, r.Source = h.agentID, projectstore.RoleSide, h.model, projectstore.SourceACP
	r.FlatRate = h.flat
	c, cancel := dbCtx(context.Background())
	defer cancel()
	if _, err := h.rt.db.RecordUsage(c, r); err != nil {
		h.rt.logErr("record side usage", err)
	}
}

// RequestPermission lets the agent read and search; everything else (edits,
// commands, deletes, moves, unknown kinds) is rejected.
func (h *sideHandler) RequestPermission(_ context.Context, req acp.PermissionRequest) string {
	switch req.ToolCall.Kind {
	case "read", "search", "think", "fetch":
		if o, ok := req.FirstOption(acp.AllowOnce); ok {
			return o.ID
		}
	}
	h.mu.Lock()
	h.refused++
	h.mu.Unlock()
	if o, ok := req.FirstOption(acp.RejectOnce, acp.RejectAlways); ok {
		return o.ID
	}
	return ""
}

func (h *sideHandler) ReadTextFile(_ context.Context, req acp.ReadTextFileParams) (string, error) {
	root, label, rel, err := h.rt.locate(req.Path)
	if err != nil {
		return "", err
	}
	content, _, err := files.Read(root, rel)
	if err != nil {
		return "", fmt.Errorf("read %s/%s: %w", label, rel, err)
	}
	return sliceLines(content, req.Line, req.Limit), nil
}

func (h *sideHandler) WriteTextFile(context.Context, acp.WriteTextFileParams) error {
	return fmt.Errorf("refused: a side question is read-only and cannot write files")
}

// finish flushes what the secret scrubbers held back, records the answer's
// output tokens (reported by the agent, else estimated at four characters a
// token) and returns the answer text.
func (h *sideHandler) finish() string {
	h.mu.Lock()
	if rest := h.stream.Flush(); rest != "" {
		h.text.WriteString(rest)
		h.rt.publish(events.SideDelta, map[string]any{"side_id": h.sideID, "text": rest})
	}
	if rest := h.thought.Flush(); rest != "" {
		h.rt.publish(events.SideThinking, map[string]any{"side_id": h.sideID, "text": rest})
	}
	h.done = true
	var out int64
	est := false
	if h.reported != nil {
		out = h.reported.OutputTokens + h.reported.ThoughtTokens
	}
	if out == 0 {
		out, est = (h.runes+3)/4, true
	}
	text := strings.TrimSpace(h.text.String())
	h.mu.Unlock()
	if out > 0 {
		h.record(projectstore.UsageRecord{OutputTokens: out, TokensEstimated: est})
	}
	return text
}
