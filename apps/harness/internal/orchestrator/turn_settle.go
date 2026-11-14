package orchestrator

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/ndolinschi/Octo/apps/harness/internal/agent"
	"github.com/ndolinschi/Octo/apps/harness/internal/memory"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
)

// ACPDigestTimeout is how long an ACP orchestrator may take to answer the one
// digest prompt asked in its live session.
const ACPDigestTimeout = 30 * time.Second

// commandChangesState reports whether a shell command can change state: any
// segment of it (split on && ; | and newlines) that is not on the read-only
// allow-list of ReadOnlyCommand. A turn that only ran read-only commands did
// no work (memory M6 rule 1); a pipeline of them is still read-only.
func commandChangesState(cmd string) bool {
	cmd = strings.TrimSpace(cmd)
	if cmd == "" {
		return false
	}
	segs := strings.FieldsFunc(strings.NewReplacer("&&", "\n", "||", "\n", ";", "\n", "|", "\n").Replace(cmd), func(r rune) bool { return r == '\n' })
	for _, seg := range segs {
		if seg = strings.TrimSpace(seg); seg != "" && !ReadOnlyCommand(seg) {
			return true
		}
	}
	return false
}

// noteCommand counts a command the turn ran when it can change state.
func (rt *runtime) noteCommand(cmd string) {
	if commandChangesState(cmd) {
		rt.turnCommands.Add(1)
	}
}

// turnWork gathers what the harness knows about the finished turn without a
// model: the changes ledger, commands, sub-agents, plan, the session.
func (rt *runtime) turnWork(status projectstore.AgentStatus, reply string) memory.TurnWork {
	ctx, cancel := dbCtx(context.Background())
	defer cancel()
	w := memory.TurnWork{
		MessageID: rt.turnID, Request: rt.request, Reply: reply, Touched: rt.touchedFiles(), TaskID: rt.currentTask(),
		Commands: int(rt.turnCommands.Load()), Plan: rt.turnPlan.Load() || rt.planText != "",
		Completed: status == projectstore.StatusCompleted, Cancelled: status == projectstore.StatusCancelled,
	}
	request, _, _, started, err := rt.db.MessageText(ctx, rt.turnID)
	if err == nil && strings.TrimSpace(request) != "" {
		w.Request = request
	}
	if sid, err := rt.db.SessionOfTurn(ctx, rt.turnID); err == nil {
		w.SessionID = sid
	}
	if files, err := rt.db.ChangedPaths(ctx, rt.turnID); err == nil {
		w.Changed = files
	}
	if started != "" {
		if agents, err := rt.db.SubAgentTitlesIn(ctx, started, rt.sessionID); err == nil {
			w.SubAgents = agents
		}
	}
	return w
}

// settleTurn ends the turn for the task list (memory M6). It never makes a
// record by itself for a question that was only answered: the exchange is the
// record. Digest sources, in order: the project's side model when the
// built-in loop can run; else, for an ACP orchestrator that did work, one
// prompt in its live session (30 s, never shown as a user turn); else nothing
// (a minimal record is built from the facts the harness has). A failed digest
// falls back the same way.
func (o *Orchestrator) settleTurn(rt *runtime, orchID string, status projectstore.AgentStatus, reply string) {
	if rt.turnID == 0 {
		return
	}
	w := rt.turnWork(status, reply)
	viaModel := o.opts.MemoryDigest && o.builtinOff() == ""
	viaAgent := !viaModel && o.opts.MemoryDigest && rt.isACPOrchestrator() && w.DidWork()
	if !w.Completed || !(viaModel || viaAgent) || o.baseCtx.Err() != nil {
		o.applySettle(rt, w, nil)
		return
	}
	o.wg.Add(1)
	o.settling.Add(1)
	go func() {
		defer o.wg.Done()
		defer o.settling.Done()
		ctx, cancel := context.WithTimeout(o.baseCtx, 90*time.Second)
		defer cancel()
		var d *memory.Digest
		var err error
		if viaModel {
			d, err = rt.digest(ctx, orchID, w)
		} else {
			d, err = rt.askACPDigest(ctx, w)
		}
		if err != nil {
			if errors.Is(err, context.Canceled) && o.baseCtx.Err() != nil {
				return
			}
			slog.Warn("memory digest failed", "project", rt.pid(), "via", map[bool]string{true: "model", false: "agent"}[viaModel], "err", err)
			d = nil
		}
		o.applySettle(rt, w, d)
	}()
}

func (o *Orchestrator) applySettle(rt *runtime, w memory.TurnWork, d *memory.Digest) {
	ctx, cancel := dbCtx(context.Background())
	defer cancel()
	if _, err := rt.memory().SettleTurn(ctx, w, d); err != nil {
		rt.logErr("settle task record", err)
	}
}

func (rt *runtime) digestInput(ctx context.Context, w memory.TurnWork) string {
	m := rt.memory()
	return m.Redact(memory.DigestInput(w, m.KnownFacts(ctx, "", 20), m.Candidates(ctx, w.SessionID)...))
}

// digest asks the project's side model for the turn's digest (no tools).
func (rt *runtime) digest(ctx context.Context, orchID string, w memory.TurnWork) (*memory.Digest, error) {
	loop := agent.Loop{
		Client: rt.o.opts.Client, Registry: tools.NewRegistry(), Model: rt.models.SideModel(), System: memory.DigestPrompt,
		MaxTurns: 1, Stream: false, SessionID: "digest:" + orchID,
		Sink:            &digestSink{rt: rt, agentID: orchID, role: "digest"},
		NoPromptCaching: rt.o.opts.NoPromptCaching, Limits: rt.o.opts.Limits, Router: rt.o.opts.Router,
		Hints: rt.sideHints(), Gate: rt.loopGate(),
	}
	res, err := loop.Run(ctx, []anthropic.MessageParam{anthropic.NewUserMessage(anthropic.NewTextBlock(rt.digestInput(ctx, w)))})
	if err != nil {
		return nil, err
	}
	d, err := memory.ParseDigest(res.Text)
	if err != nil {
		return nil, err
	}
	return &d, nil
}
