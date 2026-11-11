package orchestrator

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/ndolinschi/Octo/apps/harness/internal/activity"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
	"github.com/ndolinschi/Octo/apps/harness/internal/agent"
	"github.com/ndolinschi/Octo/apps/harness/internal/permission"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/secrets"
)

const toolNameFallback = "tool"

// acpSession is the acp.Handler for one ACP sub-agent: it turns the agent's
// updates into events and an SDK-shaped persisted transcript.
type acpSession struct {
	rt      *runtime
	sink    *agentSink
	agentID string
	label   string
	model   string
	// orchestrator marks the session of an ACP-run orchestrator.
	orchestrator bool

	mu       sync.Mutex
	pending  strings.Builder
	all      []string
	tail     string
	open     map[string]bool
	seen     map[string]bool
	lastUsed int64
	// order, titles and claimed let an MCP tool call find the ACP tool_call
	// row the agent announced for it.
	order    []string
	titles   map[string]string
	claimed  map[string]bool
	lastCost float64
	done     bool
	// preOK counts edits the user allowed through session/request_permission,
	// by absolute path; preAny those that named no path.
	// said and acted count what the agent produced: non-blank text, tool calls.
	said  bool
	acted bool
	// active is set once the agent has done anything in this session handler
	// (text, a tool call, usage, a permission request).
	active bool
	// flat marks a flat-rate (subscription) agent.
	flat   bool
	preOK  map[string]int
	preAny int
	// calls keeps what the agent announced for each tool call (session/update
	// tool_call), to complete a permission request that names only the id.
	calls map[string]acp.ToolCall
	// harness maps the harness tools an ACP orchestrator may call (name ->
	// input schema) so its tool_call rows can be stored under the tool's own name.
	harness map[string]json.RawMessage
	mapped  map[string]string // tool call id -> harness tool name
	rawIn   map[string]json.RawMessage
	// stream scrubs stored secrets out of the text deltas published while the agent talks.
	stream *secrets.Stream
	// thought does the same for the reasoning deltas.
	thought *secrets.Stream
	// lastEvent is when anything last arrived from the agent; quiet says
	// agent.activity already reported the silence; waiting that the agent
	// waits for the user; stopWatch ends the silence watcher.
	lastEvent time.Time
	quiet     bool
	waiting   bool
	stopWatch chan struct{}
}

// quietAfter is the silence after which an ACP agent is reported as quiet.
const defaultQuietAfter = 10 * time.Second

func newACPSession(rt *runtime, agentID, label, model string) *acpSession {
	s := &acpSession{
		rt: rt, sink: &agentSink{rt: rt, agentID: agentID, source: projectstore.SourceACP},
		agentID: agentID, label: label, model: model,
		open: map[string]bool{}, seen: map[string]bool{}, titles: map[string]string{}, claimed: map[string]bool{},
		preOK: map[string]int{}, calls: map[string]acp.ToolCall{}, stream: rt.o.secrets.NewStream(rt.pid()), mapped: map[string]string{}, rawIn: map[string]json.RawMessage{},
		thought: rt.o.secrets.NewStream(rt.pid()), lastEvent: time.Now(), stopWatch: make(chan struct{}),
	}
	rt.activity(agentID, activity.Thinking, "Starting "+label, "")
	go s.watchSilence()
	return s
}

// touch records a sign of life from the agent.
func (s *acpSession) touch() {
	s.lastEvent, s.quiet = time.Now(), false
}

// watchSilence publishes agent.activity "quiet" once when nothing at all has
// arrived from the agent for the quiet period (not while it waits for the user).
func (s *acpSession) watchSilence() {
	after := s.rt.o.opts.ACPQuietAfter
	if after <= 0 {
		after = defaultQuietAfter
	}
	tick := time.NewTicker(max(after/4, 5*time.Millisecond))
	defer tick.Stop()
	for {
		select {
		case <-s.stopWatch:
			return
		case <-tick.C:
		}
		s.mu.Lock()
		fire := !s.done && !s.waiting && !s.quiet && time.Since(s.lastEvent) >= after
		if fire {
			s.quiet = true
		}
		s.mu.Unlock()
		if fire {
			s.rt.activity(s.agentID, activity.Quiet, s.label, "")
		}
	}
}

// UpdateSeen implements acp.UpdateObserver: every session/update is a sign of life.
func (s *acpSession) UpdateSeen(_ context.Context, _ string) {
	s.mu.Lock()
	s.touch()
	s.mu.Unlock()
}

// AgentThought implements acp.ThoughtHandler: the reasoning streams to the UI
// (secrets scrubbed) and is stored nowhere.
func (s *acpSession) AgentThought(_ context.Context, text string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.done {
		return
	}
	s.active = true
	s.rt.activity(s.agentID, activity.Thinking, "Thinking", "")
	if safe := s.thought.Write(text); safe != "" {
		s.rt.publish(events.ThinkingDelta, map[string]any{"agent_id": s.agentID, "text": safe})
	}
}

// flushThoughtLocked publishes what the secret scrubber still holds back.
func (s *acpSession) flushThoughtLocked() {
	if rest := s.thought.Flush(); rest != "" {
		s.rt.publish(events.ThinkingDelta, map[string]any{"agent_id": s.agentID, "text": rest})
	}
}

// Plan implements acp.PlanHandler: the agent's whole plan replaces the stored
// one and is published.
func (s *acpSession) Plan(ctx context.Context, entries []acp.PlanEntry) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.done {
		return
	}
	s.active = true
	plan := make([]projectstore.PlanEntry, 0, len(entries))
	for _, e := range entries {
		e.Content = strings.TrimSpace(s.rt.redact(e.Content))
		if e.Content == "" {
			continue
		}
		if e.Status == "" {
			e.Status = "pending"
		}
		if e.Priority == "" {
			e.Priority = "medium"
		}
		plan = append(plan, projectstore.PlanEntry{Content: e.Content, Status: e.Status, Priority: e.Priority})
	}
	c, cancel := dbCtx(ctx)
	defer cancel()
	if _, err := s.rt.db.SetPlan(c, s.agentID, plan); err != nil {
		s.rt.logErr("store plan", err)
	}
	s.rt.publish(events.AgentPlan, map[string]any{"agent_id": s.agentID, "entries": plan})
}

// toolLabelLocked is the activity label of an announced tool call.
func (s *acpSession) toolLabelLocked(call acp.ToolCall) string {
	if tool, ok := s.mapped[call.ID]; ok {
		return activity.ForTool(tool, call.RawInput)
	}
	loc := ""
	if len(call.Locations) > 0 {
		loc = call.Locations[0].Path
	}
	cwd := ""
	if len(s.rt.folders) > 0 {
		cwd = s.rt.folders[0].Path
	}
	return activity.ForACP(call.Kind, call.Title, loc, cwd)
}

func (s *acpSession) AgentText(_ context.Context, text string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.done {
		return
	}
	s.active = true
	s.rt.activity(s.agentID, activity.Text, "Writing", "")
	s.flushThoughtLocked()
	if strings.TrimSpace(text) != "" {
		s.said = true
	}
	s.pending.WriteString(text)
	if safe := s.stream.Write(text); safe != "" {
		s.sink.TextDelta(safe)
	}
}

func (s *acpSession) ToolCall(ctx context.Context, call acp.ToolCall) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.active, s.acted = true, true
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
	s.active, s.acted = true, true
	if s.done {
		return
	}
	fresh := !s.seen[up.ID]
	if fresh {
		s.flushLocked(ctx)
		s.startLocked(ctx, up)
	} else {
		s.updateToolLocked(up)
	}
	if up.Status.Terminal() && s.open[up.ID] {
		s.finishToolLocked(ctx, up)
	}
}

// updateToolLocked merges a tool_call_update into what was announced and
// publishes tool.updated with the fields that changed.
func (s *acpSession) updateToolLocked(up acp.ToolCallUpdate) {
	known := s.calls[up.ID]
	fields := map[string]any{"agent_id": s.agentID, "tool_use_id": up.ID}
	if up.Status != "" && up.Status != known.Status {
		known.Status = up.Status
		fields["status"] = string(up.Status)
	}
	if up.Title != "" && up.Title != known.Title {
		known.Title = up.Title
		fields["title"] = s.rt.redact(up.Title)
	}
	if up.Kind != "" {
		known.Kind = up.Kind
	}
	if len(up.Locations) > 0 {
		known.Locations = up.Locations
		paths := make([]string, 0, len(up.Locations))
		for _, l := range up.Locations {
			paths = append(paths, l.Path)
		}
		fields["locations"] = paths
	}
	if len(up.RawInput) > 0 && string(up.RawInput) != "null" {
		known.RawInput = up.RawInput
	}
	if sum := activity.Clip(s.rt.redact(flattenContent(up.Content)), 300); sum != "" {
		fields["summary"] = sum
	}
	s.calls[up.ID] = known
	if len(fields) > 2 {
		s.rt.publish(events.ToolUpdated, fields)
	}
	if s.open[up.ID] && !up.Status.Terminal() {
		s.rt.activity(s.agentID, activity.Tool, s.toolLabelLocked(known), up.ID)
	}
}

// Usage maps a usage_update: the window goes on the agent, the growth in used
// tokens and the increase in (USD) cost become one usage row.
func (s *acpSession) Usage(_ context.Context, u acp.Usage) {
	s.mu.Lock()
	delta := u.Used - s.lastUsed
	s.lastUsed = u.Used
	cost := s.costDeltaLocked(u.Cost)
	s.mu.Unlock()
	w := projectstore.ContextWindow{Used: u.Used, Size: u.Size}
	if delta <= 0 && cost == nil {
		s.sink.setContext(w)
		return
	}
	u2 := agent.Usage{Model: s.model, InputTokens: max(delta, 0), CostUSD: cost}
	if s.flat && cost != nil {
		// A subscription agent's figure is what the usage would cost per token,
		// not what was paid: kept, flagged, and left out of spend.
		u2.CostEstimated, u2.FlatRate = true, true
	}
	s.sink.record(u2, &w)
}

// costDeltaLocked converts the cumulative cost of a usage_update into the
// increase since the previous one. Only USD is understood; a counter that went
// backwards is taken as restarted.
func (s *acpSession) costDeltaLocked(c *acp.Cost) *float64 {
	if c == nil || !strings.EqualFold(c.Currency, "USD") || c.Amount < 0 {
		return nil
	}
	d := c.Amount - s.lastCost
	if d < 0 {
		d = c.Amount
	}
	s.lastCost = c.Amount
	if d == 0 {
		return nil
	}
	return &d
}

// nothing reports whether the agent produced no text and no tool call.
func (s *acpSession) nothing() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return !s.said && !s.acted
}

// idle reports whether the agent has done nothing yet in this handler.
func (s *acpSession) idle() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return !s.active
}

func (s *acpSession) RequestPermission(ctx context.Context, req acp.PermissionRequest) string {
	s.mu.Lock()
	s.active = true
	s.touch()
	asks := s.rt.supervised(ctx)
	if asks {
		s.waiting = true
	}
	s.mu.Unlock()
	req.ToolCall = s.completed(req.ToolCall)
	if asks {
		s.rt.activity(s.agentID, activity.WaitingApproval, "Waiting for your approval", "")
		defer func() {
			s.mu.Lock()
			s.waiting = false
			s.touch()
			s.mu.Unlock()
			s.rt.activity(s.agentID, activity.Thinking, "Thinking", "")
		}()
	}
	d := permission.Decide(ctx, permission.Request{
		ProjectID: s.rt.pid(), Agent: s.label, Orchestrator: s.orchestrator, ACP: req,
		AgentID: s.agentID, TurnID: s.rt.turnID, Policy: approvalPolicy{rt: s.rt},
	})
	if d.Allow {
		s.preapprove(req.ToolCall)
	}
	return d.OptionID
}

// completed fills what a permission request's tool call leaves out (title,
// kind, locations, raw input) from the tool call the agent announced.
func (s *acpSession) completed(c acp.ToolCall) acp.ToolCall {
	s.mu.Lock()
	known, ok := s.calls[c.ID]
	s.mu.Unlock()
	if !ok {
		return c
	}
	if c.Title == "" {
		c.Title = known.Title
	}
	if c.Kind == "" {
		c.Kind = known.Kind
	}
	if len(c.Locations) == 0 {
		c.Locations = known.Locations
	}
	if len(c.RawInput) == 0 || string(c.RawInput) == "null" {
		c.RawInput = known.RawInput
	}
	return c
}

// preapprove remembers that the user allowed an edit the agent announced, so
// the fs/write_text_file that carries it out is not asked about a second time.
func (s *acpSession) preapprove(call acp.ToolCallUpdate) {
	switch call.Kind {
	case "edit", "delete", "move":
	default:
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, l := range call.Locations {
		s.preOK[filepath.Clean(l.Path)]++
	}
	if len(call.Locations) == 0 {
		s.preAny++
	}
}

// consumePreapproval uses up one pre-approval for path (or a path-less one).
func (s *acpSession) consumePreapproval(path string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p := filepath.Clean(path); s.preOK[p] > 0 {
		s.preOK[p]--
		return true
	}
	if s.preAny > 0 {
		s.preAny--
		return true
	}
	return false
}

// finish flushes trailing text and closes tool calls the agent left open.
func (s *acpSession) finish(ctx context.Context, failed bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.done {
		return
	}
	s.flushLocked(ctx)
	s.flushThoughtLocked()
	close(s.stopWatch)
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
	if rest := s.stream.Flush(); rest != "" {
		s.sink.TextDelta(rest)
	}
	text := s.rt.redact(s.pending.String())
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
	var persistedInput any = input
	if tool, ok := s.harnessToolOf(call); ok {
		// A call to one of the harness's own tools: stored as the built-in loop
		// stores it (the tool's name and its arguments), so it renders the same.
		name = tool
		s.mapped[call.ID] = tool
		s.rawIn[call.ID] = call.RawInput
		args := json.RawMessage(call.RawInput)
		if len(args) == 0 || string(args) == "null" {
			args = json.RawMessage("{}")
		}
		persistedInput = args
	}
	s.seen[call.ID] = true
	s.calls[call.ID] = call
	s.order = append(s.order, call.ID)
	s.titles[call.ID] = call.Title + " " + string(call.RawInput)
	s.open[call.ID] = true
	s.tail = ""
	s.persist(ctx, "assistant", anthropic.NewAssistantMessage(anthropic.NewToolUseBlock(call.ID, persistedInput, name)))
	s.sink.ToolStarted(call.ID, name)
	s.flushThoughtLocked()
	s.rt.activity(s.agentID, activity.Tool, s.toolLabelLocked(call), call.ID)
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
	s.persist(ctx, "user", anthropic.NewUserMessage(anthropic.NewToolResultBlock(id, s.rt.o.opts.Limits.CapResult(text), isErr)))
	s.sink.ToolFinished(id, isErr)
	if len(s.open) == 0 {
		s.rt.activity(s.agentID, activity.Thinking, "Thinking", "")
	}
}

func (s *acpSession) persist(ctx context.Context, role string, msg anthropic.MessageParam) {
	if err := s.sink.Message(ctx, role, msg); err != nil {
		s.rt.logErr("persist acp message", err)
	}
}

// claimToolUse finds the open, not yet claimed tool call the agent announced
// for an MCP call to the harness tool `name` and claims it, so the sub-agent a
// spawn_agent call creates links to that transcript row. Rows are matched by
// the call's arguments against the row's raw input (title, task, tier ...);
// a row that carries no raw input falls back to its title naming the tool. The
// agent announces a call before it makes it, but the two travel on different
// connections, so it retries briefly. "" means no row matched; the call still runs.
func (s *acpSession) claimToolUse(ctx context.Context, name string, args json.RawMessage) string {
	for attempt := 0; attempt < 30; attempt++ {
		s.mu.Lock()
		for _, id := range s.order {
			if !s.open[id] || s.claimed[id] {
				continue
			}
			if s.mapped[id] == name && argsMatch(s.rawIn[id], args) || s.mapped[id] == "" && strings.Contains(s.titles[id], name) {
				s.claimed[id] = true
				s.mu.Unlock()
				return id
			}
		}
		s.mu.Unlock()
		select {
		case <-ctx.Done():
			return ""
		case <-time.After(10 * time.Millisecond):
		}
	}
	return ""
}

// compareKeys are the arguments argsMatch compares.
var compareKeys = []string{"title", "task", "tier", "role", "agent", "model", "command", "path", "name", "content"}

// argsMatch reports whether an announced raw input and an MCP call's arguments
// can be the same call: every compared key present in both has the same value.
// Without a raw input there is nothing to contradict.
func argsMatch(raw, args json.RawMessage) bool {
	var a, b map[string]any
	if json.Unmarshal(raw, &a) != nil || json.Unmarshal(args, &b) != nil {
		return true
	}
	for _, k := range compareKeys {
		if x, ok := a[k]; ok {
			if y, ok := b[k]; ok && fmt.Sprint(x) != fmt.Sprint(y) {
				return false
			}
		}
	}
	return true
}
