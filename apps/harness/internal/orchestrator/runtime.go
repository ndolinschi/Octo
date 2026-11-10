package orchestrator

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/ndolinschi/Octo/apps/harness/internal/agent"
	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools/local"
)

// runtime is a snapshot of one project taken at turn start, plus helpers
// shared by every agent in the turn's tree.
type runtime struct {
	o       *Orchestrator
	db      *projectstore.DB
	info    projectstore.Project
	models  config.Models
	folders []projectstore.Folder
	notes   []projectstore.Note
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
	if err := local.RegisterRoots(reg, rt.roots(), names...); err != nil {
		return nil, err
	}
	if a.Depth < rt.info.MaxDepth {
		if err := reg.Register(rt.spawnDef(a)); err != nil {
			return nil, err
		}
	}
	if isOrch {
		for _, d := range rt.noteDefs() {
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
	history, err := rt.loadHistory(ctx, orch.ID)
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
	loop := agent.Loop{
		Client:    rt.o.opts.Client,
		Registry:  reg,
		Model:     a.Model,
		System:    rt.systemPrompt(a),
		MaxTurns:  rt.o.opts.MaxTurns,
		Stream:    rt.o.opts.Stream,
		SessionID: a.ID,
		Sink:      &agentSink{rt: rt, agentID: a.ID},
	}
	return loop.Run(ctx, history)
}

// settle records an agent's final state and announces it.
func (rt *runtime) settle(ctx context.Context, id string, status projectstore.AgentStatus, result, errText string) {
	c, cancel := dbCtx(ctx)
	defer cancel()
	now := projectstore.Now()
	patch := projectstore.AgentPatch{Status: &status, FinishedAt: &now}
	if result != "" {
		patch.Result = &result
	}
	if errText != "" {
		patch.Error = &errText
	}
	a, err := rt.db.UpdateAgent(c, id, patch)
	if err != nil {
		rt.logErr("settle agent", err)
		return
	}
	rt.publishAgent(events.AgentUpdated, a)
}

// finishTurn settles the orchestrator, cancels any stragglers and ends the turn.
func (rt *runtime) finishTurn(orchID string, status projectstore.AgentStatus, text, errText string) {
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
	idle, now := projectstore.StatusIdle, projectstore.Now()
	patch := projectstore.AgentPatch{Status: &idle, FinishedAt: &now}
	if text != "" {
		patch.Result = &text
	}
	if errText != "" {
		patch.Error = &errText
	}
	if a, err := rt.db.UpdateAgent(c, orchID, patch); err == nil {
		rt.publishAgent(events.AgentUpdated, a)
	} else {
		rt.logErr("settle orchestrator", err)
	}
	var e any
	if errText != "" {
		e = errText
	}
	rt.publish(events.TurnFinished, map[string]any{"status": string(status), "error": e})
}
