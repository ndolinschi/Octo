package orchestrator

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/ndolinschi/Octo/apps/harness/internal/activity"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
	"github.com/ndolinschi/Octo/apps/harness/internal/approval"
	"github.com/ndolinschi/Octo/apps/harness/internal/diff"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/features"
	"github.com/ndolinschi/Octo/apps/harness/internal/memory"
	"github.com/ndolinschi/Octo/apps/harness/internal/permission"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// Approvals lists the project's pending approvals.
func (o *Orchestrator) Approvals(pid string) []approval.Approval { return o.approvals.List(pid) }

// ResolveApproval answers a pending approval.
//
// An allow_always answer first saves the rule it stands for (approval.Validate:
// the suggested one, or the client's Match when it covers the request) and
// refuses with approval.ErrNoRule or approval.ErrInvalid when none can be saved,
// leaving the approval pending.
func (o *Orchestrator) ResolveApproval(pid, id string, r approval.Resolution) error {
	if r.Decision != approval.AllowAlways {
		return o.approvals.Resolve(pid, id, r)
	}
	ap, ok := o.approvals.Pending(pid, id)
	if !ok {
		return approval.ErrNotFound
	}
	spec, err := approval.Validate(ap.Tool, ap.Detail, r.Match)
	if err != nil {
		return err
	}
	ctx, cancel := dbCtx(context.Background())
	defer cancel()
	db, err := o.store.Get(ctx, pid)
	if err != nil {
		return err
	}
	rule, err := db.AddApprovalRule(ctx, spec.Tool, spec.Match, spec.Exact)
	if err != nil {
		return err
	}
	o.hub.Publish(pid, events.ApprovalRuleCreated, map[string]any{"rule": rule})
	return o.approvals.Resolve(pid, id, r)
}

// publishAttention announces how many things wait for the user in a project
// (approvals and open forms), so a client can show "needs you".
// The event also lists, per main session that has anything waiting, its counts (sessions).
func (o *Orchestrator) publishAttention(pid string) {
	a, in := o.approvals.Count(pid), o.inputs.Count(pid)
	o.hub.Publish(pid, events.ProjectAttention, map[string]any{"needs_you": a+in > 0, "approvals": a, "inputs": in,
		"sessions": o.SessionsAttention(pid)})
}

// Attention returns the counts publishAttention announces.
func (o *Orchestrator) Attention(pid string) (approvals, inputs int) {
	return o.approvals.Count(pid), o.inputs.Count(pid)
}

// SessionAttention counts what waits for the person in one main session: its approvals and open forms.
func (o *Orchestrator) SessionAttention(pid, sid string) (approvals, inputs int) {
	for _, a := range o.approvals.List(pid) {
		if a.SessionID == sid {
			approvals++
		}
	}
	for _, f := range o.inputs.List(pid) {
		if f.SessionID == sid {
			inputs++
		}
	}
	return approvals, inputs
}

// SessionNeed is one main session's entry of project.attention: what waits for the person there, and whether
// its last turn failed.
type SessionNeed struct {
	SessionID string `json:"session_id"`
	NeedsYou  bool   `json:"needs_you"`
	Approvals int    `json:"approvals"`
	Inputs    int    `json:"inputs"`
	Failed    bool   `json:"failed"`
}

// SessionsAttention lists the main sessions that need the person (approvals, forms) or whose last turn failed.
func (o *Orchestrator) SessionsAttention(pid string) []SessionNeed {
	by := map[string]*SessionNeed{}
	var order []string
	get := func(sid string) *SessionNeed {
		if n := by[sid]; n != nil {
			return n
		}
		by[sid] = &SessionNeed{SessionID: sid}
		order = append(order, sid)
		return by[sid]
	}
	for _, a := range o.approvals.List(pid) {
		if a.SessionID != "" {
			n := get(a.SessionID)
			n.Approvals++
			n.NeedsYou = true
		}
	}
	for _, f := range o.inputs.List(pid) {
		if f.SessionID != "" {
			n := get(f.SessionID)
			n.Inputs++
			n.NeedsYou = true
		}
	}
	ctx, cancel := dbCtx(context.Background())
	defer cancel()
	if db, err := o.store.Get(ctx, pid); err == nil {
		if roots, err := db.Roots(ctx); err == nil {
			for _, r := range roots {
				if r.SessionID != "" && rootFailed(r) && !o.ActiveSession(pid, r.SessionID) {
					get(r.SessionID).Failed = true
				}
			}
		}
	}
	out := make([]SessionNeed, 0, len(order))
	for _, sid := range order {
		out = append(out, *by[sid])
	}
	return out
}

// rootFailed: a root agent's last turn failed (its error, not a warning, stays on the row until the next request).
func rootFailed(a projectstore.Agent) bool {
	return a.Status == projectstore.StatusFailed || (a.Error != nil && *a.Error != "" && !strings.HasPrefix(*a.Error, "warning:"))
}

// accessMode reads the project's access mode now (a change applies to the
// next request, also within a running turn).
func (rt *runtime) accessMode(ctx context.Context) string {
	c, cancel := dbCtx(ctx)
	defer cancel()
	info, err := rt.db.Info(c)
	if err != nil {
		return projectstore.AccessFull
	}
	return info.Access
}

// memoryMode reads the project's live auto_memory setting ("off", "allow", "review", or "blocked").
func (rt *runtime) memoryMode(ctx context.Context) string {
	c, cancel := dbCtx(ctx)
	defer cancel()
	info, err := rt.db.Info(c)
	if err != nil {
		return memory.AutoMemoryOff
	}
	return memory.ParseSettings(info.MemoryJSON).AutoMemory
}

func (rt *runtime) featureEnabled(id string) bool {
	return rt.o.opts.Features.Enabled(id)
}

// approveMemory checks the auto_memory feature flag and the project's auto_memory setting before saving memory.
// When "allow", it returns allowed immediately. When "blocked" or disabled by feature flag, it refuses without prompting.
// When "off" or "review", it raises a KindMemory approval card (even in access="full" projects).
func (rt *runtime) approveMemory(ctx context.Context, agentID, label, title string, detail approval.Detail) (bool, string) {
	switch rt.memoryMode(ctx) {
	case memory.AutoMemoryBlocked:
		return false, "Memory is disabled for this project."
	case memory.AutoMemoryAllow:
		return true, ""
	}
	if !rt.featureEnabled(features.AutoMemory) {
		return false, "Auto-memory is disabled by feature flag."
	}
	m := rt.o.approvals
	if m.Granted(rt.pid(), rt.turnID, agentID, approval.KindMemory) {
		return true, "" // "Allow all for this request" earlier in the turn
	}
	ap := approval.Approval{
		AgentID: agentID, AgentLabel: label, TurnID: rt.turnID, SessionID: rt.sessionID,
		Kind: approval.KindMemory, Title: title, Detail: detail,
	}
	rt.activity(agentID, activity.WaitingApproval, "Enable auto memory?", "")
	res := m.Request(ctx, rt.pid(), ap)
	rt.activity(agentID, activity.Thinking, "Thinking", "")
	if res.Decision == approval.AllowAllForTurn {
		m.GrantAll(rt.pid(), rt.turnID)
	}
	if res.Decision != approval.Deny {
		return true, ""
	}
	if rt.memoryMode(ctx) == memory.AutoMemoryBlocked {
		return false, "Memory was blocked for this project."
	}
	if strings.TrimSpace(res.Note) != "" {
		return false, strings.TrimSpace(res.Note)
	}
	return false, "Not saved: memory approval was declined."
}

func (rt *runtime) asksKind(ctx context.Context, kind string) bool {
	switch rt.accessMode(ctx) {
	case projectstore.AccessSupervised:
		return true
	case projectstore.AccessAcceptEdits:
		return kind != approval.KindWrite
	default:
		return false
	}
}

func isEditACP(call acp.ToolCall) bool {
	switch call.Kind {
	case "edit", "delete", "move":
		return true
	}
	return false
}

func (rt *runtime) asksACP(ctx context.Context, call acp.ToolCall) bool {
	if call.Kind == "read" || call.Kind == "search" {
		return false
	}
	switch rt.accessMode(ctx) {
	case projectstore.AccessSupervised:
		return true
	case projectstore.AccessAcceptEdits:
		return !isEditACP(call)
	default:
		return false
	}
}

// agentLabel names an agent for an approval card.
func agentLabel(a projectstore.Agent) string { return a.Role }

// ask raises an approval for agent and waits. It returns ok, or false with
// the reason the user gave. grantKey is what "allow for this turn" remembers.
func (rt *runtime) ask(ctx context.Context, agentID, label string, ap approval.Approval, grantKey string) (bool, string) {
	if !rt.asksKind(ctx, ap.Kind) {
		return true, ""
	}
	m := rt.o.approvals
	if m.Granted(rt.pid(), rt.turnID, agentID, grantKey) {
		return true, ""
	}
	if rt.savedRuleAllows(ctx, ap.Tool, ap.Detail) {
		return true, ""
	}
	ap.AgentID, ap.AgentLabel, ap.TurnID, ap.SessionID = agentID, label, rt.turnID, rt.sessionID
	rt.activity(agentID, activity.WaitingApproval, "Waiting for your approval", "")
	res := m.Request(ctx, rt.pid(), ap)
	rt.activity(agentID, activity.Thinking, "Thinking", "")
	if res.Decision == approval.Deny {
		return false, res.Note
	}
	// allow_always saved its rule when the answer arrived (Orchestrator.ResolveApproval).
	m.Remember(rt.pid(), rt.turnID, agentID, grantKey, res.Decision)
	return true, ""
}

// savedRuleAllows reports whether a rule the user saved ("always allow")
// covers the request. Rules are read for every request, so a rule added or
// deleted applies at once.
func (rt *runtime) savedRuleAllows(ctx context.Context, tool string, d approval.Detail) bool {
	if tool == "" {
		return false
	}
	c, cancel := dbCtx(ctx)
	defer cancel()
	rules, err := rt.db.ApprovalRules(c)
	if err != nil {
		rt.logErr("read approval rules", err)
		return false
	}
	r, ok := approval.AllowedBy(rules, tool, d)
	if ok {
		slog.Info("approval allowed by a saved rule", "project", rt.pid(), "tool", tool, "rule", r.ID)
	}
	return ok
}

// denied is the error result a tool returns when the user said no: the
// agent is told why when the user said so.
func denied(note string) string {
	if strings.TrimSpace(note) == "" {
		return "Denied by the user."
	}
	return "Denied by the user: " + strings.TrimSpace(note)
}

// program is the first word of a shell command, the unit "allow for this turn"
// remembers for commands.
func program(command string) string {
	f := strings.Fields(command)
	if len(f) == 0 {
		return ""
	}
	return filepath.Base(f[0])
}

// writeDetail describes a write of content to rel under folder: the size of
// the change against what is on disk now.
func writeDetail(folder, abs, rel, content string) approval.Detail {
	d := approval.Detail{Folder: folder, Path: rel}
	old := ""
	if data, err := os.ReadFile(abs); err == nil && len(data) <= 2<<20 {
		old = string(data)
	}
	a, r := diff.Count(old, content)
	d.Diff = &approval.DiffStat{Added: a, Removed: r}
	d.Patch = diff.Unified(rel, old, content, 3, 20_000)
	return d
}

// approveWrite asks before a write (write_file or ACP fs/write_text_file).
func (rt *runtime) approveWrite(ctx context.Context, agentID, label, tool, folder, abs, rel, content string) (bool, string) {
	verb := "Write "
	if tool == approval.ToolEdit {
		verb = "Edit "
	}
	return rt.ask(ctx, agentID, label, approval.Approval{
		Kind: approval.KindWrite, Title: verb + rel, Tool: tool, Detail: writeDetail(folder, abs, rel, content),
	}, approval.KindWrite)
}

// approveFetch asks before a web_fetch.
func (rt *runtime) approveFetch(ctx context.Context, agentID, label, rawURL, host string) (bool, string) {
	return rt.ask(ctx, agentID, label, approval.Approval{
		Kind: approval.KindNetwork, Title: "Fetch " + clip(rawURL, 200), Tool: approval.ToolWebFetch, Detail: approval.Detail{URL: rawURL},
	}, approval.KindNetwork+":"+host)
}

// approveCommand asks before a shell command.
func (rt *runtime) approveCommand(ctx context.Context, agentID, label, folder, command string) (bool, string) {
	title := strings.TrimSpace(command)
	if i := strings.IndexByte(title, '\n'); i >= 0 {
		title = title[:i] + " ..."
	}
	return rt.ask(ctx, agentID, label, approval.Approval{
		Kind: approval.KindCommand, Title: clip(title, 200), Tool: approval.ToolBash, Detail: approval.Detail{Folder: folder, Command: command},
	}, approval.KindCommand+":"+program(command))
}

// approvalPolicy answers one agent's session/request_permission: automatically
// for full access (exactly today's behaviour), through an approval card for a
// supervised project.
type approvalPolicy struct{ rt *runtime }

func (p approvalPolicy) Decide(ctx context.Context, req permission.Request) permission.Decision {
	if p.rt.readOnlyMode() {
		// Ask and plan: nothing that changes anything, whatever the access mode.
		if p.rt.acpModeAllows(req.ACP.ToolCall) {
			return permission.AutoApprove{}.Decide(ctx, req)
		}
		return p.pick(req, approval.Deny, "", p.rt.modeRefusal("this action"))
	}
	call := req.ACP.ToolCall
	if !p.rt.asksACP(ctx, call) {
		return permission.AutoApprove{}.Decide(ctx, req)
	}
	key := approval.KindACP + ":" + call.Kind
	m := p.rt.o.approvals
	pid := p.rt.pid()
	if m.Granted(pid, req.TurnID, req.AgentID, key) {
		return p.pick(req, approval.Allow, "", "")
	}
	detail, tool := p.detail(req.ACP), approval.ACPToolPrefix+call.Kind
	if p.rt.savedRuleAllows(ctx, tool, detail) {
		return p.pick(req, approval.Allow, "", "")
	}
	res := m.Request(ctx, pid, approval.Approval{
		AgentID: req.AgentID, AgentLabel: req.Agent, TurnID: req.TurnID, Kind: approval.KindACP, Tool: tool,
		Title: firstNonEmpty(call.Title, call.Kind, "Permission request"), Detail: detail,
	})
	m.Remember(pid, req.TurnID, req.AgentID, key, res.Decision)
	return p.pick(req, res.Decision, res.OptionID, res.Note)
}

// detail names what the agent asked for: the command and the paths, when it said.
func (p approvalPolicy) detail(r acp.PermissionRequest) approval.Detail {
	d := approval.Detail{Command: commandOf(r.ToolCall.RawInput)}
	for _, o := range r.Options {
		d.Options = append(d.Options, approval.Option{ID: o.ID, Label: o.Name, Kind: string(o.Kind)})
	}
	if len(r.ToolCall.Locations) > 0 {
		abs := r.ToolCall.Locations[0].Path
		if _, label, rel, err := p.rt.locate(abs); err == nil {
			d.Folder, d.Path = label, rel
		} else {
			d.Path = abs
		}
	}
	return d
}

// pick maps the user's answer onto an option the agent offered. An allow
// needs an allow option and a deny a reject option; without one the request
// is cancelled (an empty OptionID), which agents treat as a refusal.
func (p approvalPolicy) pick(req permission.Request, decision, optionID, note string) permission.Decision {
	allow := decision != approval.Deny // allow, allow_for_turn, allow_all_for_turn and allow_always
	kinds := []acp.OptionKind{acp.RejectOnce, acp.RejectAlways}
	if allow {
		kinds = []acp.OptionKind{acp.AllowOnce, acp.AllowAlways}
	}
	if optionID != "" {
		for _, o := range req.ACP.Options {
			if o.ID == optionID && (o.Kind == kinds[0] || o.Kind == kinds[1]) {
				return permission.Decision{OptionID: o.ID, Allow: allow, Reason: note}
			}
		}
	}
	if o, ok := req.ACP.FirstOption(kinds...); ok {
		return permission.Decision{OptionID: o.ID, Allow: allow, Reason: note}
	}
	return permission.Decision{Allow: false, Reason: "no " + string(kinds[0]) + " option offered"}
}

// commandOf extracts a shell command from an ACP tool call's rawInput.
func commandOf(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var in struct {
		Command any `json:"command"`
		Cmd     any `json:"cmd"`
	}
	if json.Unmarshal(raw, &in) != nil {
		return ""
	}
	for _, v := range []any{in.Command, in.Cmd} {
		switch c := v.(type) {
		case string:
			return c
		case []any:
			parts := make([]string, 0, len(c))
			for _, x := range c {
				parts = append(parts, fmt.Sprint(x))
			}
			return strings.Join(parts, " ")
		}
	}
	return ""
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}
