package orchestrator

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/ndolinschi/Octo/apps/harness/internal/approval"
	"github.com/ndolinschi/Octo/apps/harness/internal/changes"
	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/inputs"
	"github.com/ndolinschi/Octo/apps/harness/internal/memory"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/prices"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/router"
	"github.com/ndolinschi/Octo/apps/harness/internal/secrets"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

var (
	ErrTurnInProgress = errors.New("orchestrator: turn already in progress")
	ErrShuttingDown   = errors.New("orchestrator: shutting down")
)

// NoteBook is the note persistence the orchestrator's note tools call.
type NoteBook interface {
	Save(ctx context.Context, projectID, title, content string) (projectstore.Note, error)
	DeleteByTitle(ctx context.Context, projectID, title string) error
	// Read returns a note with its body and records the read (read_note).
	Read(ctx context.Context, projectID, id string) (projectstore.Note, error)
	// Search finds notes by title, description and body (search_notes).
	Search(ctx context.Context, projectID, query string, limit int) ([]projectstore.NoteHit, error)
	// Write creates (no id) or updates (id) a note; the description is required (write_note).
	Write(ctx context.Context, projectID, id, title, description, body string, tags *[]string) (note projectstore.Note, created bool, err error)
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
	// AgentSource, when set, supplies the agents (with their current login
	// state) in place of Agents each time one is needed.
	AgentSource func() []plugins.Agent
	// BuiltinUnavailable, when non-empty, says the built-in Messages-API loop
	// cannot run (no key, no router); it is the error every agent, sub-agent
	// and side question that needs it ends with, and no request is sent.
	BuiltinUnavailable string
	// DefaultOrchestrator is the server's default orchestrator model. While
	// the built-in loop is unavailable, a project whose orchestrator equals it
	// runs on the first available, logged-in ACP agent instead (see
	// EffectiveOrchestrator).
	DefaultOrchestrator string
	// Router is the detected Octo router (nil: the base URL is not one).
	Router *router.Router
	// Prices estimate cost for the harness's own budget enforcement.
	Prices prices.Table
	// Windows are the configured per-model context sizes for GET .../context.
	Windows config.ContextWindows
	// ACPIdle is how long an ACP-run orchestrator's agent process may sit idle
	// before it is shut down (zero: DefaultACPIdle).
	ACPIdle time.Duration
	// SideIdle is how long a side conversation's ACP session may sit unused
	// before it is closed (zero: DefaultSideIdle).
	SideIdle time.Duration
	// Clock is the time source of the side-session idle close (nil: time.Now).
	Clock func() time.Time
	// MCPRelay is the command (and leading arguments) of the stdio relay given
	// to ACP agents without HTTP MCP support; the harness appends --url and
	// --token-env. Empty: this executable with "mcp-relay".
	MCPRelay []string
	// ApprovalTimeout is how long an approval request waits for an answer
	// before it is denied (zero: approval.DefaultTimeout; negative: never).
	ApprovalTimeout time.Duration
	// MemoryDigest makes the harness digest every completed turn into its task
	// record with one side-model call (M1). `harness serve` turns it on; it is
	// off here so that embedders and tests that count model requests see none.
	MemoryDigest bool
	// ACPQuietAfter is how long an ACP agent may send nothing at all during a
	// prompt before agent.activity says "quiet" (zero: 10 s).
	ACPQuietAfter time.Duration
	// Secrets is the project secret store; nil makes one under each project's data directory.
	Secrets *secrets.Manager
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
	// settling counts the digests of finished turns still being written to the task list (settleTurn); tests wait on it.
	settling sync.WaitGroup

	acp *acpHost
	// side holds the ACP sessions of side conversations.
	side *sideHost
	// imgCaps remembers which ACP agents take images.
	imgCaps imageCaps
	// adv holds what ACP agents advertised (AdvertisedModels).
	adv advertisedStore

	trackers  map[string]*changes.Tracker // guarded by mu
	memories  map[string]*memory.Service  // guarded by mu
	approvals *approval.Manager
	inputs    *inputs.Manager
	secrets   *secrets.Manager

	defaultOrch   atomic.Pointer[string] // the server default orchestrator (SetDefaultOrchestrator)
	builtinReason atomic.Pointer[string] // overrides Options.BuiltinUnavailable (SetBuiltinUnavailable)

	// qmu serializes queue decisions (see queue.go); sendNow marks a project
	// whose running turn was cancelled by SendNow. Lock order: qmu before mu.
	qmu     sync.Mutex
	sendNow map[string]bool
	// steer holds, per project with a running built-in orchestrator turn, the
	// queued messages waiting to be injected at its next tool boundary.
	steerMu sync.Mutex
	steer   map[string]*steerBox

	mu    sync.Mutex
	turns map[string]context.CancelFunc
	// runs are the sub-agent runs that can be stopped or messaged from their session, by agent id (sessions.go).
	runs map[string]*agentRun
	// live: a turn started and its turn.finished is not published yet (see finish).
	live   map[string]bool
	sides  map[string]*side
	bridge string
}

func New(store *projectstore.Store, hub *events.Hub, notes NoteBook, opts Options) *Orchestrator {
	ctx, stop := context.WithCancel(context.Background())
	o := &Orchestrator{
		store: store, hub: hub, notes: notes, opts: opts, acp: newACPHost(opts.ACPIdle), side: newSideHost(),
		baseCtx: ctx, stop: stop, turns: make(map[string]context.CancelFunc), live: make(map[string]bool), sides: make(map[string]*side),
		trackers: make(map[string]*changes.Tracker), memories: make(map[string]*memory.Service), sendNow: make(map[string]bool),
		steer: make(map[string]*steerBox),
	}
	o.approvals = approval.New(o.hub.Publish, o.publishAttention, opts.ApprovalTimeout)
	o.inputs = inputs.New(o.hub.Publish, o.publishAttention)
	o.secrets = opts.Secrets
	if o.secrets == nil {
		o.secrets = secrets.New(store.ProjectDir)
	}
	def := opts.DefaultOrchestrator
	o.defaultOrch.Store(&def)
	o.wg.Add(1)
	go func() {
		defer o.wg.Done()
		o.acp.reap(ctx)
	}()
	o.wg.Add(1)
	go func() {
		defer o.wg.Done()
		o.reapSideLoop(ctx)
	}()
	o.wg.Add(1)
	go func() {
		defer o.wg.Done()
		o.pruneAttachmentsLoop(ctx)
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
	defer o.side.closeAll()
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
	return o.StartWith(ctx, projectID, text, StartOpts{})
}

// StartWith is Start with the turn's mode and an optional pinned plan.
func (o *Orchestrator) StartWith(ctx context.Context, projectID, text string, opts StartOpts) (projectstore.Message, error) {
	if o.baseCtx.Err() != nil {
		return projectstore.Message{}, ErrShuttingDown
	}
	turnCtx, cancel := context.WithCancel(o.baseCtx)
	if !o.claim(projectID, cancel) {
		cancel()
		return projectstore.Message{}, ErrTurnInProgress
	}
	msg, rt, orch, err := o.begin(ctx, projectID, text, opts)
	if err != nil {
		cancel()
		o.release(projectID)
		return projectstore.Message{}, err
	}
	// A built-in turn can take steered messages from the moment it is claimed
	// until it is finished (an ACP turn never can).
	closeBox := func() {}
	if !rt.isACPOrchestrator() {
		closeBox = o.openSteerBox(projectID)
	}
	o.wg.Add(1)
	go func() {
		defer o.wg.Done()
		defer cancel()
		status, finished := o.runTurn(turnCtx, rt, orch)
		o.qmu.Lock()
		closeBox()
		o.finish(projectID, finished)
		o.advance(projectID, status)
		o.qmu.Unlock()
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
	o.live[projectID] = true
	return true
}

func (o *Orchestrator) release(projectID string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	delete(o.turns, projectID)
	delete(o.live, projectID)
}

// finish ends a turn for the outside world in one step: the turn slot is
// released (a client that reacts to turn.finished can start the next turn),
// turn.finished is published, and the project stops being Active. All three
// happen under o.mu, which Active also takes, so nobody can see the project as
// idle (the agent row says idle before this) without turn.finished already
// published: a client that polls for idle and then subscribes would otherwise
// catch the previous turn's turn.finished as the next turn's.
func (o *Orchestrator) finish(projectID string, finished map[string]any) {
	o.mu.Lock()
	defer o.mu.Unlock()
	delete(o.turns, projectID)
	o.hub.Publish(projectID, events.TurnFinished, finished)
	delete(o.live, projectID)
}

// Active reports whether a turn has started and its turn.finished has not been
// published yet. A project in that state is reported as running whatever its
// orchestrator row says.
func (o *Orchestrator) Active(projectID string) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.live[projectID]
}

func (o *Orchestrator) begin(ctx context.Context, projectID, text string, opts StartOpts) (projectstore.Message, *runtime, projectstore.Agent, error) {
	db, err := o.store.Get(ctx, projectID)
	if err != nil {
		return projectstore.Message{}, nil, projectstore.Agent{}, err
	}
	orch, err := db.Orchestrator(ctx)
	if err != nil {
		return projectstore.Message{}, nil, projectstore.Agent{}, err
	}
	o.memoryOf(db) // installs the secret redactor of the search index before anything is indexed
	rt, err := o.newRuntime(ctx, db)
	if err != nil {
		return projectstore.Message{}, nil, projectstore.Agent{}, err
	}
	if err := rt.repairDangling(ctx, orch.ID); err != nil {
		return projectstore.Message{}, nil, projectstore.Agent{}, err
	}
	// A retry sends the text of a turn that failed before it answered: the
	// stored user message is run again, not stored a second time.
	msg, retried := rt.failedRequest(ctx, orch, text)
	reportNote := ""
	if sid, err := db.CurrentSessionID(ctx); err == nil {
		rt.sessionID = sid
	}
	if !retried {
		// What the user collected from sub-agent sessions for the orchestrator is stored before the request.
		reportNote = rt.pendingReportNote(ctx, orch.ID)
		content, err := rt.userContent(ctx, text, opts.Attachments)
		if err != nil {
			return projectstore.Message{}, nil, projectstore.Agent{}, err
		}
		command := opts.Command
		if name := SlashToken(text); command == "" && rt.isACPOrchestrator() && o.agentCommandNamed(rt, name) {
			if _, octo := OctoCommandIn(text); !octo {
				command = name
			}
		}
		if msg, err = db.AppendMessageCommand(ctx, orch.ID, "user", content, command); err != nil {
			return projectstore.Message{}, nil, projectstore.Agent{}, err
		}
	}
	rt.turnID = msg.ID
	rt.request = text
	rt.reportNote = reportNote
	if projectstore.ValidMode(opts.Mode) {
		rt.mode = opts.Mode
	}
	rt.planText = opts.PlanText
	o.memoryOf(db).ExpireStale(ctx)
	if !retried {
		rt.publish(events.MessageCreated, map[string]any{"message": msg})
	}
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
	rt.publishSession(rt.sessionID, false)
	if retried {
		rt.publishTurnState(attentionNone, nil)
	}
	return msg, rt, orch, nil
}

func (o *Orchestrator) runTurn(ctx context.Context, rt *runtime, orch projectstore.Agent) (projectstore.AgentStatus, map[string]any) {
	res, err := rt.runOrchestrator(ctx, orch)
	status := projectstore.StatusCompleted
	var problem, notice *usererr.Error
	switch {
	case err == nil:
	case ctx.Err() != nil, errors.Is(err, errAgentCancelled):
		status = projectstore.StatusCancelled
	default:
		status, problem = projectstore.StatusFailed, describe(err)
		slog.Error("turn failed", "project", rt.pid(), "err", err)
	}
	if status == projectstore.StatusCompleted && rt.isACPOrchestrator() {
		// A notice, not a failure: the session works without harness tools.
		notice = o.acp.warning(rt.pid())
	}
	o.approvals.EndTurn(rt.pid(), rt.turnID)
	if status == projectstore.StatusCompleted && rt.mode == projectstore.ModePlan {
		rt.turnPlan.Store(true)
		o.savePlan(rt, res.Text)
	}
	finished := rt.finishTurn(orch.ID, status, res.Text, problem, notice)
	rt.publish(events.ContextUpdated, map[string]any{"project_id": rt.pid()})
	o.recordExchange(rt, orch.ID, status, res.Text)
	rt.publishSession(rt.sessionID, false)
	o.settleTurn(rt, orch.ID, status, res.Text)
	return status, finished
}
