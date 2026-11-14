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
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
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
	// turnCommands counts the turn's commands that can change state and turnPlan says it produced a
	// plan (memory M6: facts the harness has without a model); touched are the files tool calls read or changed.
	turnCommands atomic.Int32
	turnPlan     atomic.Bool
	// remembered counts the items the turn's agents kept with the remember tool.
	remembered atomic.Int32
	touchMu    sync.Mutex
	touched    []string
	o          *Orchestrator
	db         *projectstore.DB
	info       projectstore.Project
	models     config.Models
	folders    []projectstore.Folder
	notes      []projectstore.Note
	// turnID is the id of the user message that started the turn (0 outside a turn).
	turnID int64
	// sessionID is the main session the turn runs in; reportNote the note of sub-agent results handed over at its start.
	sessionID, reportNote string
	// taskID is the task record of the turn's request ("" when none was opened).
	taskID string
	taskMu sync.Mutex
	// rcpt is the context receipt of the turn (see window.go).
	rcpt   *Receipt
	rcptMu sync.Mutex
	// request is the text of the user's request that started the turn ("" outside one).
	request string
	// mode is the turn's mode (the project's until a turn overrides it) and
	// planText an approved plan pinned in the context.
	mode     string
	planText string
	// instr caches the instruction files read for each agent this turn.
	instrMu sync.Mutex
	instr   map[string]instrEntry
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
	mode := info.Mode
	if !projectstore.ValidMode(mode) {
		mode = projectstore.ModeAgent
	}
	return &runtime{o: o, db: db, info: info, models: models, folders: folders, notes: notes, mode: mode}, nil
}

// newSessionRuntime is newRuntime for a turn of one main session: the session's model and mode (when it chose
// them) replace the project's.
func (o *Orchestrator) newSessionRuntime(ctx context.Context, db *projectstore.DB, sid string) (*runtime, error) {
	rt, err := o.newRuntime(ctx, db)
	if err != nil {
		return nil, err
	}
	rt.sessionID = sid
	if model, mode, err := db.SessionModel(ctx, sid); err == nil {
		if model != "" {
			rt.models.Orchestrator = o.EffectiveOrchestrator(model)
		}
		if projectstore.ValidMode(mode) {
			rt.mode = mode
		}
	}
	return rt, nil
}

func (rt *runtime) pid() string { return rt.db.ID() }

// key is the key of the runtime's main session (steer box, ACP session, turn slot).
func (rt *runtime) key() string { return skey(rt.pid(), rt.sessionID) }

// publish sends an event of the project; an event about the work of a main session carries its session_id
// (unless the fields name one already).
func (rt *runtime) publish(typ string, fields map[string]any) {
	if rt.sessionID != "" {
		if fields == nil {
			fields = map[string]any{}
		}
		if _, ok := fields["session_id"]; !ok {
			fields["session_id"] = rt.sessionID
		}
	}
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
	if typ == events.AgentUpdated && a.ParentID != nil {
		// The sub-agent's session follows its row (state, model, last activity).
		c, cancel := dbCtx(context.Background())
		defer cancel()
		if info, err := rt.db.SessionOfAgent(c, a.ID); err == nil {
			rt.publish(events.SessionUpdated, map[string]any{"session": rt.o.SessionView(c, rt.db, info)})
		}
	}
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

// registry builds the tool set for an agent kind (see the spec's tool table);
// in an ask or plan turn the write tools, delegation and writing shell commands are refused.
func (rt *runtime) registry(a projectstore.Agent) (*tools.Registry, error) {
	reg, err := rt.baseRegistry(a)
	if err != nil {
		return nil, err
	}
	rt.guardMode(reg)
	return reg, nil
}

func (rt *runtime) baseRegistry(a projectstore.Agent) (*tools.Registry, error) {
	reg := tools.NewRegistry()
	isOrch := a.ParentID == nil
	names := local.AllTools
	if isOrch {
		names = []string{local.ToolListDir, local.ToolReadFile, local.ToolEdit, local.ToolGlob}
	}
	if err := local.RegisterRootsLimits(reg, rt.roots(), rt.o.opts.Limits, names...); err != nil {
		return nil, err
	}
	rt.guardTools(reg, a)
	if rt.info.Network == projectstore.NetworkOn {
		if err := reg.Register(rt.webFetchDef(a)); err != nil {
			return nil, err
		}
	}
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
	if err := reg.Register(rt.rememberDef(a)); err != nil {
		return nil, err
	}
	if isOrch {
		for _, d := range append(rt.noteDefs(), rt.memoryDefs()...) {
			if err := reg.Register(d); err != nil {
				return nil, err
			}
		}
		return reg, nil
	}
	// Sub-agents look notes up and write them like the orchestrator, but see no index.
	for _, d := range append(rt.noteReadDefs(), rt.noteWriteDefs()...) {
		if err := reg.Register(d); err != nil {
			return nil, err
		}
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
		OutputCap:       rt.outputCap(a.Model),
		BudgetCut:       rt.budgetCut,
	}
	if a.ParentID != nil {
		loop.Steer = rt.o.steerTextsOf(a.ID) // a message the user sent to this sub-agent's session
	}
	if a.ParentID == nil {
		loop.Steer = rt.steerTexts
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
	if err != nil {
		// What a cancelled or failed turn had written is kept, flagged stopped (cut short): a
		// stream that broke off (the provider or the router went away) keeps the text it had sent.
		sink.keepPartial(ctx)
		if a.ParentID != nil && ctx.Err() != nil {
			// A stopped sub-agent's interrupted calls get their result at the stop, as the orchestrator's do
			// (runTurn): a reload shows the stopped step, and a continuation starts from a closed transcript.
			c, cancel := dbCtx(ctx)
			if rerr := rt.repairDangling(c, a.ID); rerr != nil {
				rt.logErr("close a stopped sub-agent's calls", rerr)
			}
			cancel()
		}
	}
	return res, err
}

// settle records an agent's final state and announces it.
func (rt *runtime) settle(ctx context.Context, id string, status projectstore.AgentStatus, result, errText string) {
	rt.settleHint(ctx, id, status, result, errText, "")
}

// settleProblem settles a failed agent with a catalogue error: its plain
// message and hint on the row.
func (rt *runtime) settleProblem(ctx context.Context, id string, p *usererr.Error) {
	rt.settleHint(ctx, id, projectstore.StatusFailed, "", p.Message, p.Hint)
}

// modelText is what a model reads about a failure: the plain message and, for
// it to reason about, the technical details.
func modelText(p *usererr.Error) string {
	if p.Details == "" {
		return p.Message
	}
	return p.Message + " (" + p.Details + ")"
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
//
// problem is the failure of a failed turn; notice is the standing notice of a
// completed one (an agent that runs without Octo's tools). Both are catalogue
// errors: the row and the payload carry the plain message and the hint (the
// message of a notice keeps the "warning: " marker the row has always had),
// the payload adds command, action and details, and a notice also as `notice`.
func (rt *runtime) finishTurn(orchID string, status projectstore.AgentStatus, text string, problem, notice *usererr.Error) map[string]any {
	errText, hint := "", ""
	shown := problem
	if shown == nil {
		shown = notice
	}
	if shown != nil {
		shown = rt.redactProblem(shown)
		errText, hint = shown.Message, shown.Hint
		if problem == nil {
			errText = "warning: " + errText
		}
	}
	ctx := context.Background()
	c, cancel := dbCtx(ctx)
	defer cancel()
	if agents, err := rt.db.Agents(c); err == nil {
		for _, a := range agents {
			// Only this session's sub-agents: other sessions' turns run at the same time.
			if a.ParentID != nil && a.Status == projectstore.StatusRunning && (rt.sessionID == "" || a.SessionID == rt.sessionID) {
				if r := rt.o.runOf(a.ID); r != nil && r.detached {
					continue // continued by the user from its session: not part of this turn
				}
				rt.settle(ctx, a.ID, projectstore.StatusCancelled, "", "")
			}
		}
	} else {
		rt.logErr("list agents", err)
	}
	text = rt.redact(text)
	// The orchestrator is idle after every turn; a failed one leaves its error
	// on the row until the next request starts (project.attention says failed).
	idle, now := projectstore.StatusIdle, projectstore.Now()
	patch := projectstore.AgentPatch{Status: &idle, FinishedAt: &now}
	if text != "" {
		patch.Result = &text
	}
	if errText != "" {
		patch.Error = &errText
		if hint != "" {
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
	if shown != nil {
		shown.AddTo(out, "hint", "command", "action", "details")
		if problem == nil {
			out["notice"] = shown.Fields()
		}
	}
	if status == projectstore.StatusFailed {
		rt.publishTurnState(attentionFailed, shown)
	}
	return out
}
