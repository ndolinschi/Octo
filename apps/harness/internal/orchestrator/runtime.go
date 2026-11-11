package orchestrator

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/ndolinschi/Octo/apps/harness/internal/activity"
	"sync"
	"sync/atomic"
	"time"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/ndolinschi/Octo/apps/harness/internal/agent"
	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools/local"
)

// changeRetention is how long a recorded change keeps its diff.
const changeRetention = 30 * 24 * time.Hour

// defaultClearWindow is the context window assumed for tool-result clearing when
// none is configured (HARNESS_CONTEXT_WINDOWS): the table is empty by design.
const defaultClearWindow = 200_000

// runtime is a snapshot of one project taken at turn start, plus helpers
// shared by every agent in the turn's tree.
type runtime struct {
	// actMu guards lastAct, the last agent.activity published per agent.
	actMu   sync.Mutex
	lastAct map[string]string
	// turnTools counts the turn's tool calls; touched are the files they read or changed.
	turnTools atomic.Int32
	touchMu   sync.Mutex
	touched   []string
	o         *Orchestrator
	db        *projectstore.DB
	info      projectstore.Project
	models    config.Models
	folders   []projectstore.Folder
	notes     []projectstore.Note
	// turnID is the id of the user message that started the turn (0 outside a turn).
	turnID int64
	// taskID is the task record of the turn's request ("" when none was opened).
	taskID string
	taskMu sync.Mutex
	// rcpt is the context receipt of the turn (see window.go).
	rcpt   *Receipt
	rcptMu sync.Mutex
}

func (rt *runtime) currentTask() string {
	rt.taskMu.Lock()
	defer rt.taskMu.Unlock()
	return rt.taskID
}

func (rt *runtime) setTask(id string) {
	rt.taskMu.Lock()
	rt.taskID = id
	rt.taskMu.Unlock()
}

func (o *Orchestrator) newRuntime(ctx context.Context, db *projectstore.DB) (*runtime, error) {
	info, err := db.Info(ctx)
	if err != nil {
		return nil, err
	}
	models := config.DefaultModels()
	if err := json.Unmarshal([]byte(info.ModelsJSON), &models); err != nil {
		return nil, fmt.Errorf("project models: %w", err)
	}
	// Chosen per turn, never stored.
	models.Orchestrator = o.EffectiveOrchestrator(models.Orchestrator)
	folders, err := db.Folders(ctx)
	if err != nil {
		return nil, err
	}
	notes, err := db.Notes(ctx)
	if err != nil {
		return nil, err
	}
	return &runtime{o: o, db: db, info: info, models: models, folders: folders, notes: notes}, nil
}

func (rt *runtime) pid() string { return rt.db.ID() }

func (rt *runtime) publish(typ string, fields map[string]any) {
	rt.o.hub.Publish(rt.pid(), typ, fields)
}

// activity publishes agent.activity when the agent's state changed since the
// last one (the same kind, label and tool id twice is one event).
func (rt *runtime) activity(agentID, kind, label, toolID string) {
	label = rt.redact(label)
	key := kind + "\x00" + label + "\x00" + toolID
	rt.actMu.Lock()
	if rt.lastAct == nil {
		rt.lastAct = map[string]string{}
	}
	if rt.lastAct[agentID] == key {
		rt.actMu.Unlock()
		return
	}
	rt.lastAct[agentID] = key
	rt.actMu.Unlock()
	fields := map[string]any{"agent_id": agentID, "kind": kind, "label": label}
	if toolID != "" {
		fields["tool_use_id"] = toolID
	}
	rt.publish(events.AgentActivity, fields)
}

func (rt *runtime) publishAgent(typ string, a projectstore.Agent) {
	rt.publish(typ, map[string]any{"agent": a})
}

func dbCtx(parent context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(parent), 10*time.Second)
}

func (rt *runtime) roots() []local.Root {
	roots := make([]local.Root, len(rt.folders))
	for i, f := range rt.folders {
		roots[i] = local.Root{Label: f.Label, Path: f.Path}
	}
	return roots
}

// registry builds the tool set for an agent kind (see the spec's tool table).
func (rt *runtime) registry(a projectstore.Agent) (*tools.Registry, error) {
	reg := tools.NewRegistry()
	isOrch := a.ParentID == nil
	names := local.AllTools
	if isOrch {
		names = []string{local.ToolListDir, local.ToolReadFile}
	}
	if err := local.RegisterRootsLimits(reg, rt.roots(), rt.o.opts.Limits, names...); err != nil {
		return nil, err
	}
	rt.guardTools(reg, a)
	if err := reg.Register(rt.inputDef(a)); err != nil {
		return nil, err
	}
	if a.Depth < rt.info.MaxDepth {
		def, err := rt.spawnDef(a)
		if err != nil {
			return nil, err
		}
		if err := reg.Register(def); err != nil {
			return nil, err
		}
	}
	if isOrch {
		for _, d := range append(rt.noteDefs(), rt.memoryDefs()...) {
			if err := reg.Register(d); err != nil {
				return nil, err
			}
		}
		return reg, nil
	}
	for _, d := range rt.o.opts.Remote {
		if _, taken := reg.Get(d.Name); !taken {
			if err := reg.Register(d); err != nil {
				return nil, err
			}
		}
	}
	return reg, nil
}

func (rt *runtime) runOrchestrator(ctx context.Context, orch projectstore.Agent) (agent.Result, error) {
	if rt.isACPOrchestrator() {
		return rt.runACPOrchestrator(ctx, orch)
	}
	history, err := rt.orchestratorHistory(ctx, orch, true)
	if err != nil {
		return agent.Result{}, err
	}
	return rt.runAgent(ctx, orch, history)
}

// runAgent runs one agent's loop over history and records its messages.
func (rt *runtime) runAgent(ctx context.Context, a projectstore.Agent, history []anthropic.MessageParam) (agent.Result, error) {
	reg, err := rt.registry(a)
	if err != nil {
		return agent.Result{}, err
	}
	sink := &agentSink{rt: rt, agentID: a.ID}
	loop := agent.Loop{
		Client:    rt.o.opts.Client,
		Registry:  reg,
		Model:     a.Model,
		System:    rt.systemPrompt(a),
		MaxTurns:  rt.o.opts.MaxTurns,
		Stream:    rt.o.opts.Stream,
		SessionID: a.ID,
		Sink:      sink,

		NoPromptCaching: rt.o.opts.NoPromptCaching,
		Limits:          rt.o.opts.Limits,
		Router:          rt.o.opts.Router,
		Hints:           rt.hints(a),
		Gate:            rt.loopGate(),
	}
	if a.ParentID == nil {
		// Old tool results become stubs once a request passes 60% of the window,
		// in both memory modes, before compaction is considered.
		w := int64(defaultClearWindow)
		if p := rt.window("", a); p != nil {
			w = *p
		}
		loop.Clear = &agent.ClearPolicy{WindowTokens: w}
		sink.onCleared = rt.addCleared
	}
	res, err := loop.Run(ctx, history)
	if err != nil && ctx.Err() != nil {
		sink.keepPartial(ctx) // what a cancelled turn had written is kept, flagged stopped
	}
	return res, err
}

// settle records an agent's final state and announces it.
func (rt *runtime) settle(ctx context.Context, id string, status projectstore.AgentStatus, result, errText string) {
	rt.settleHint(ctx, id, status, result, errText, "")
}

// settleHint is settle with the hint that goes with the error.
func (rt *runtime) settleHint(ctx context.Context, id string, status projectstore.AgentStatus, result, errText, hint string) {
	c, cancel := dbCtx(ctx)
	defer cancel()
	now := projectstore.Now()
	patch := projectstore.AgentPatch{Status: &status, FinishedAt: &now}
	result, errText = rt.redact(result), rt.redact(errText)
	if result != "" {
		patch.Result = &result
	}
	if errText != "" {
		patch.Error = &errText
		if hint = rt.redact(hint); hint != "" {
			patch.ErrorHint = &hint
		}
	}
	a, err := rt.db.UpdateAgent(c, id, patch)
	if err != nil {
		rt.logErr("settle agent", err)
		return
	}
	rt.publishAgent(events.AgentUpdated, a)
	rt.activity(id, activity.Idle, "", "")
}

// finishTurn settles the orchestrator and cancels any stragglers. It returns
// the turn.finished payload; the caller publishes it once the turn's slot is
// released, so a client that reacts to turn.finished never meets "turn already
// in progress".
func (rt *runtime) finishTurn(orchID string, status projectstore.AgentStatus, text, errText, hint string) map[string]any {
	ctx := context.Background()
	c, cancel := dbCtx(ctx)
	defer cancel()
	if agents, err := rt.db.Agents(c); err == nil {
		for _, a := range agents {
			if a.ParentID != nil && a.Status == projectstore.StatusRunning {
				rt.settle(ctx, a.ID, projectstore.StatusCancelled, "", "")
			}
		}
	} else {
		rt.logErr("list agents", err)
	}
	text, errText = rt.redact(text), rt.redact(errText)
	idle, now := projectstore.StatusIdle, projectstore.Now()
	patch := projectstore.AgentPatch{Status: &idle, FinishedAt: &now}
	if text != "" {
		patch.Result = &text
	}
	if errText != "" {
		patch.Error = &errText
		if hint = rt.redact(hint); hint != "" {
			patch.ErrorHint = &hint
		}
	}
	if a, err := rt.db.UpdateAgent(c, orchID, patch); err == nil {
		rt.publishAgent(events.AgentUpdated, a)
		rt.activity(orchID, activity.Idle, "", "")
	} else {
		rt.logErr("settle orchestrator", err)
	}
	// Diffs older than the retention window go; the rows stay.
	if _, err := rt.db.PruneBlobs(c, projectstore.Stamp(time.Now().Add(-changeRetention))); err != nil {
		rt.logErr("prune change blobs", err)
	}
	var e any
	if errText != "" {
		e = errText
	}
	out := map[string]any{"status": string(status), "error": e}
	if hint != "" && errText != "" {
		out["hint"] = hint
	}
	return out
}
