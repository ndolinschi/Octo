package orchestrator

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/prices"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/router"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
)

var (
	ErrTurnInProgress = errors.New("orchestrator: turn already in progress")
	ErrShuttingDown   = errors.New("orchestrator: shutting down")
)

// NoteBook is the note persistence the orchestrator's note tools call.
type NoteBook interface {
	Save(ctx context.Context, projectID, title, content string) (projectstore.Note, error)
	DeleteByTitle(ctx context.Context, projectID, title string) error
}

type Options struct {
	Client   anthropic.Client
	MaxTurns int
	Stream   bool
	// NoPromptCaching drops the cache_control breakpoints from every request.
	NoPromptCaching bool
	// Limits cap tool results and sub-agent reports returned to the model
	// (zero fields mean the defaults in internal/tools).
	Limits tools.Limits
	// Remote tools are offered to sub-agents only.
	Remote []tools.Def
	// Agents are the plugin-provided ACP agents; only available ones are offered.
	Agents []plugins.Agent
	// Router is the detected Octo router (nil: the base URL is not one).
	Router *router.Router
	// Prices estimate cost for the harness's own budget enforcement.
	Prices prices.Table
	// Windows are the configured per-model context sizes for GET .../context.
	Windows config.ContextWindows
	// ACPIdle is how long an ACP-run orchestrator's agent process may sit idle
	// before it is shut down (zero: DefaultACPIdle).
	ACPIdle time.Duration
	// MCPRelay is the command (and leading arguments) of the stdio relay given
	// to ACP agents without HTTP MCP support; the harness appends --url and
	// --token-env. Empty: this executable with "mcp-relay".
	MCPRelay []string
}

// Orchestrator runs project turns: one at a time per project, each a tree of agents.
type Orchestrator struct {
	store *projectstore.Store
	hub   *events.Hub
	notes NoteBook
	opts  Options

	baseCtx context.Context
	stop    context.CancelFunc
	wg      sync.WaitGroup

	acp *acpHost

	mu     sync.Mutex
	turns  map[string]context.CancelFunc
	sides  map[string]*side
	bridge string
}

func New(store *projectstore.Store, hub *events.Hub, notes NoteBook, opts Options) *Orchestrator {
	ctx, stop := context.WithCancel(context.Background())
	o := &Orchestrator{
		store: store, hub: hub, notes: notes, opts: opts, acp: newACPHost(opts.ACPIdle),
		baseCtx: ctx, stop: stop, turns: make(map[string]context.CancelFunc), sides: make(map[string]*side),
	}
	o.wg.Add(1)
	go func() {
		defer o.wg.Done()
		o.acp.reap(ctx)
	}()
	return o
}

func (o *Orchestrator) Running(projectID string) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	_, ok := o.turns[projectID]
	return ok
}

// Cancel aborts the project's running turn, if any.
func (o *Orchestrator) Cancel(projectID string) {
	o.mu.Lock()
	cancel := o.turns[projectID]
	o.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// Shutdown cancels every turn and waits for them to settle their rows.
//
// ACP agent processes are ended last, whether or not the turns settled in time.
func (o *Orchestrator) Shutdown(ctx context.Context) error {
	o.stop()
	defer o.acp.closeAll()
	done := make(chan struct{})
	go func() { o.wg.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Start persists the user's message and runs the turn in the background.
func (o *Orchestrator) Start(ctx context.Context, projectID, text string) (projectstore.Message, error) {
	if o.baseCtx.Err() != nil {
		return projectstore.Message{}, ErrShuttingDown
	}
	turnCtx, cancel := context.WithCancel(o.baseCtx)
	if !o.claim(projectID, cancel) {
		cancel()
		return projectstore.Message{}, ErrTurnInProgress
	}
	msg, rt, orch, err := o.begin(ctx, projectID, text)
	if err != nil {
		cancel()
		o.release(projectID)
		return projectstore.Message{}, err
	}
	o.wg.Add(1)
	go func() {
		defer o.wg.Done()
		defer cancel()
		o.runTurn(turnCtx, rt, orch)
		o.release(projectID)
	}()
	return msg, nil
}

func (o *Orchestrator) claim(projectID string, cancel context.CancelFunc) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	if _, ok := o.turns[projectID]; ok {
		return false
	}
	o.turns[projectID] = cancel
	return true
}

func (o *Orchestrator) release(projectID string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	delete(o.turns, projectID)
}

func (o *Orchestrator) begin(ctx context.Context, projectID, text string) (projectstore.Message, *runtime, projectstore.Agent, error) {
	db, err := o.store.Get(ctx, projectID)
	if err != nil {
		return projectstore.Message{}, nil, projectstore.Agent{}, err
	}
	orch, err := db.Orchestrator(ctx)
	if err != nil {
		return projectstore.Message{}, nil, projectstore.Agent{}, err
	}
	rt, err := o.newRuntime(ctx, db)
	if err != nil {
		return projectstore.Message{}, nil, projectstore.Agent{}, err
	}
	if err := rt.repairDangling(ctx, orch.ID); err != nil {
		return projectstore.Message{}, nil, projectstore.Agent{}, err
	}
	content, err := json.Marshal([]anthropic.ContentBlockParamUnion{anthropic.NewTextBlock(text)})
	if err != nil {
		return projectstore.Message{}, nil, projectstore.Agent{}, err
	}
	msg, err := db.AppendMessage(ctx, orch.ID, "user", content)
	if err != nil {
		return projectstore.Message{}, nil, projectstore.Agent{}, err
	}
	rt.publish(events.MessageCreated, map[string]any{"message": msg})
	running, now := projectstore.StatusRunning, projectstore.Now()
	model := rt.models.Orchestrator
	if rt.isACPOrchestrator() {
		// Show the model the agent will really use (the manifest default included).
		if t, terr := rt.acpOrchestratorTarget(); terr == nil {
			model = t.recorded()
		}
	}
	orch, err = db.UpdateAgent(ctx, orch.ID, projectstore.AgentPatch{Status: &running, Model: &model, StartedAt: &now, Reset: true})
	if err != nil {
		return projectstore.Message{}, nil, projectstore.Agent{}, err
	}
	rt.publishAgent(events.AgentUpdated, orch)
	return msg, rt, orch, nil
}

func (o *Orchestrator) runTurn(ctx context.Context, rt *runtime, orch projectstore.Agent) {
	res, err := rt.runOrchestrator(ctx, orch)
	status, errText := projectstore.StatusCompleted, ""
	switch {
	case err == nil:
	case ctx.Err() != nil, errors.Is(err, errAgentCancelled):
		status = projectstore.StatusCancelled
	default:
		status, errText = projectstore.StatusFailed, err.Error()
		slog.Error("turn failed", "project", rt.pid(), "err", err)
	}
	if status == projectstore.StatusCompleted && rt.isACPOrchestrator() {
		// A warning, not a failure: the session works without harness tools.
		if w := o.acp.warning(rt.pid()); w != "" {
			errText = "warning: " + w
		}
	}
	rt.finishTurn(orch.ID, status, res.Text, errText)
}
