package orchestrator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"path"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
	"github.com/ndolinschi/Octo/apps/harness/internal/approval"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools/local"
)

// StartOpts are the per-turn choices of a started turn.
type StartOpts struct {
	// SessionID is the main session the turn runs in ("": the project's default session).
	SessionID string
	// Mode overrides the project's mode for this turn ("": the project's).
	Mode string
	// PlanText, when set, is an approved plan pinned at the top of the agent's context.
	PlanText string
	// Command forces the message to run the ACP agent's slash command of that name (used by
	// POST /compact, whose "/compact" is an Octo name the agent also advertises).
	Command string
	// Attachments are the ids of images stored with the message, in order.
	Attachments []string
}

// ErrNotPlan etc: errors of the plan API (mapped by the service).
var (
	ErrNoPlan         = projectstore.ErrNotFound
	ErrPlanNotPending = projectstore.ErrPlanNotPending
)

// approvePrompt is the user message of the turn a plan's approval starts.
const approvePrompt = "The plan above is approved. Carry it out."

// modeNote tells the model what its mode allows (system prompt of the
// built-in orchestrator, and a line in front of an ACP agent's prompt).
func modeNote(mode string) string {
	switch mode {
	case projectstore.ModeAsk:
		return "Mode: ASK. The user wants answers about the project, not changes. You cannot change files, run shell commands " +
			"that write, or delegate. Look things up with list_dir, read_file, glob and read-only commands, then answer. When something " +
			"would need a change, say what it is and tell the user to switch to Agent mode."
	case projectstore.ModePlan:
		return "Mode: PLAN. Investigate read-only (list_dir, read_file, glob, read-only commands), then reply with a concrete plan the " +
			"user can approve: numbered steps, the files involved, how each step is checked, and open questions. Do not change anything " +
			"and do not delegate; once the user approves, the plan is carried out in a separate turn."
	}
	return ""
}

func (rt *runtime) modeSection() string {
	if n := modeNote(rt.mode); n != "" {
		return "\n" + n + "\n"
	}
	return ""
}

// planSection pins an approved plan in the system prompt.
func (rt *runtime) planSection() string {
	if rt.planText == "" {
		return ""
	}
	return "\nApproved plan (pinned; the user approved it, carry it out and report against it):\n" + rt.planText + "\n"
}

// readOnlyMode: ask and plan turns change nothing.
func (rt *runtime) readOnlyMode() bool {
	return rt.mode == projectstore.ModeAsk || rt.mode == projectstore.ModePlan
}

// modeRefusal is the tool error of a refused call.
func (rt *runtime) modeRefusal(what string) string {
	return fmt.Sprintf("Refused: %s is not allowed in %s mode, which is read-only. Say what you would do and ask the user to switch to Agent mode.",
		what, rt.mode)
}

// guardMode makes the registry read-only for ask and plan turns, in the tool
// gate itself (the prompt asks for the same, but does not enforce it): write
// tools, delegation and shell commands that are not on the read-only list are
// refused with a message. It runs after the other guards, so a refused call
// raises no approval.
func (rt *runtime) guardMode(reg *tools.Registry) {
	if !rt.readOnlyMode() {
		return
	}
	refuse := func(what string) func(tools.Handler) tools.Handler {
		return func(tools.Handler) tools.Handler {
			return func(context.Context, json.RawMessage) (string, bool, error) {
				return rt.modeRefusal(what), true, nil
			}
		}
	}
	reg.Decorate(local.ToolWriteFile, refuse("writing files"))
	reg.Decorate(local.ToolEdit, refuse("editing files"))
	reg.Decorate(ToolSpawnAgent, refuse("delegating to a sub-agent"))
	for _, name := range []string{ToolWriteNote, ToolSaveNote, ToolDeleteNote} {
		reg.Decorate(name, refuse("writing notes"))
	}
	reg.Decorate(local.ToolBash, func(next tools.Handler) tools.Handler {
		return func(ctx context.Context, input json.RawMessage) (string, bool, error) {
			var in struct{ Command string }
			_ = json.Unmarshal(input, &in)
			if !ReadOnlyCommand(in.Command) {
				return rt.modeRefusal("this shell command (only simple read-only commands such as ls, cat, grep, git status or git diff run)"), true, nil
			}
			return next(ctx, input)
		}
	})
}

// readOnlyPrograms may run in a read-only mode, as a single simple command.
var readOnlyPrograms = map[string]bool{
	"ls": true, "cat": true, "head": true, "tail": true, "wc": true, "pwd": true, "echo": true, "grep": true, "rg": true,
	"find": true, "which": true, "file": true, "stat": true, "tree": true, "sort": true, "uniq": true, "diff": true,
	"basename": true, "dirname": true, "date": true, "du": true, "df": true, "cut": true, "tr": true, "nl": true,
}

var readOnlyGit = map[string]bool{
	"status": true, "log": true, "diff": true, "show": true, "ls-files": true, "rev-parse": true, "blame": true,
	"shortlog": true, "describe": true, "ls-tree": true, "cat-file": true,
}

// ReadOnlyCommand reports whether command is on the small allow-list of shell
// commands that cannot change anything: one simple command (approval.Tokens: no
// operator, redirection, substitution or expansion) of a known read-only program,
// without the options that would make it write or run something (find -exec,
// -delete; git --output; rg --pre; sort -o).
func ReadOnlyCommand(command string) bool {
	words, ok := approval.Tokens(command)
	if !ok {
		return false
	}
	prog := path.Base(words[0])
	args := words[1:]
	bad := func(opts ...string) bool {
		for _, a := range args {
			for _, o := range opts {
				if a == o || (strings.HasPrefix(o, "--") && strings.HasPrefix(a, o+"=")) {
					return true
				}
			}
		}
		return false
	}
	switch {
	case prog == "git":
		if len(args) == 0 || !readOnlyGit[args[0]] {
			return false
		}
		for _, a := range args {
			if strings.HasPrefix(a, "--output") || strings.HasPrefix(a, "--ext-diff") || a == "-c" || strings.HasPrefix(a, "--exec-path") {
				return false
			}
		}
		return true
	case prog == "find":
		return !bad("-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls")
	case prog == "rg":
		return !bad("--pre", "--hostname-bin")
	case prog == "sort":
		return !bad("-o", "--output")
	case prog == "diff", prog == "tree":
		return !bad("-o", "--output")
	}
	return readOnlyPrograms[prog]
}

// --- ACP orchestrators ------------------------------------------------------

// acpModeAllows reports whether a read-only mode lets an ACP permission request through.
func (rt *runtime) acpModeAllows(call acp.ToolCall) bool {
	switch call.Kind {
	case "read", "search", "think", "fetch":
		return true
	case "execute":
		return ReadOnlyCommand(commandOf(call.RawInput))
	}
	return false
}

// pickSessionMode finds the agent's own mode for ask or plan among its advertised ones.
func pickSessionMode(modes []acp.SessionMode, mode string) string {
	var words []string
	switch mode {
	case projectstore.ModeAsk:
		words = []string{"ask", "read-only", "readonly", "read_only"}
	case projectstore.ModePlan:
		words = []string{"plan"}
	}
	for _, w := range words {
		for _, m := range modes {
			if strings.Contains(strings.ToLower(m.ID), w) || strings.Contains(strings.ToLower(m.Name), w) {
				return m.ID
			}
		}
	}
	return ""
}

// applyMode puts the live ACP session into the agent's mode matching the
// turn's: ask/plan map to the agent's own read-only or plan mode when it
// advertises one (session/set_mode), and agent restores the mode the session
// started in. Without an advertised mode nothing is set: the harness denies
// the agent's write permission requests and fs writes in these modes instead
// (always, as a second line).
func (s *orchSession) applyMode(ctx context.Context, rt *runtime, client *acp.Client, sessID string) {
	s.mu.Lock()
	modes, cur, base := s.modes, s.curMode, s.baseMode
	s.mu.Unlock()
	target := ""
	if rt.readOnlyMode() {
		target = pickSessionMode(modes, rt.mode)
	} else if base != "" {
		target = base
	}
	if target == "" || target == cur {
		return
	}
	if err := client.SetMode(ctx, sessID, target); err != nil {
		slog.Warn("acp: could not set the session mode; the harness denies writes instead", "project", rt.pid(), "mode", target, "err", err)
		return
	}
	s.mu.Lock()
	s.curMode = target
	s.mu.Unlock()
}

// --- plans -------------------------------------------------------------------

// savePlan stores the result of a plan-mode turn as a plan.
func (o *Orchestrator) savePlan(rt *runtime, text string) {
	text = strings.TrimSpace(rt.redact(text))
	if text == "" {
		return
	}
	c, cancel := dbCtx(context.Background())
	defer cancel()
	p, err := rt.db.AddPlan(c, rt.turnID, text)
	if err != nil {
		rt.logErr("store plan", err)
		return
	}
	rt.publish(events.PlanCreated, map[string]any{"plan": p})
}

// LatestPlan is the default session's newest plan (projectstore.ErrNotFound: none).
func (o *Orchestrator) LatestPlan(ctx context.Context, pid string) (projectstore.Plan, error) {
	return o.LatestSessionPlan(ctx, pid, "")
}

// LatestSessionPlan is a main session's newest plan ("": the default's).
func (o *Orchestrator) LatestSessionPlan(ctx context.Context, pid, sid string) (projectstore.Plan, error) {
	db, err := o.store.Get(ctx, pid)
	if err != nil {
		return projectstore.Plan{}, err
	}
	if sid, err = o.mainSession(ctx, db, sid); err != nil {
		return projectstore.Plan{}, err
	}
	return db.LatestSessionPlan(ctx, sid)
}

// ApprovePlan marks the plan approved and starts an agent turn with it pinned
// at the top of the context. ErrTurnInProgress while a turn runs;
// projectstore.ErrNotFound and ErrPlanNotPending for the plan.
func (o *Orchestrator) ApprovePlan(ctx context.Context, pid, planID string) (projectstore.Plan, projectstore.Message, error) {
	db, err := o.store.Get(ctx, pid)
	if err != nil {
		return projectstore.Plan{}, projectstore.Message{}, err
	}
	p, err := db.Plan(ctx, planID)
	if err != nil {
		return p, projectstore.Message{}, err
	}
	if p.Status != projectstore.PlanPending {
		return p, projectstore.Message{}, ErrPlanNotPending
	}
	if p.SessionID != "" && o.RunningSession(pid, p.SessionID) || p.SessionID == "" && o.Running(pid) {
		return p, projectstore.Message{}, ErrTurnInProgress
	}
	// The approved plan runs in the session that made it.
	msg, err := o.StartWith(ctx, pid, approvePrompt, StartOpts{SessionID: p.SessionID, Mode: projectstore.ModeAgent, PlanText: p.Text})
	if err != nil {
		return p, msg, err
	}
	if p, err = db.ApprovePlan(ctx, planID); err != nil && !errors.Is(err, projectstore.ErrPlanNotPending) {
		return p, msg, err
	}
	o.hub.Publish(pid, events.PlanApproved, map[string]any{"plan": p})
	return p, msg, nil
}
