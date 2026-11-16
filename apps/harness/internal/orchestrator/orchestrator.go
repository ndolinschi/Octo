package orchestrator

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/ndolinschi/Octo/apps/harness/internal/approval"
	"github.com/ndolinschi/Octo/apps/harness/internal/changes"
	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/features"
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
	// ErrNoSlot: the running caps are reached (sessions.max_running of the project, MaxRunning of the harness);
	// a submitted message waits in its session's queue for a slot instead.
	ErrNoSlot = errors.New("orchestrator: no free slot for another running session")
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
	// OllamaBaseURL is the Ollama server URL for the small completion tier (default config.DefaultOllamaBaseURL).
	OllamaBaseURL string
	// SmallCompletionModel is the initial Ollama small-tier model tag (default config.DefaultOllamaSmallModel).
	SmallCompletionModel string
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
	// MaxRunning caps the main sessions running turns at once across every project
	// (HARNESS_MAX_RUNNING_SESSIONS; zero: config.DefaultMaxRunningSessions). A project's own cap is its
	// sessions.max_running setting (default 3).
	MaxRunning int
	// Features holds the process-wide feature flags; nil falls back to defaults.
	Features *features.Store
}

// Orchestrator runs project turns: one at a time per main session (several sessions of a project at once,
// within the running caps), each a tree of agents. Per-session state is keyed by skey(project, session).
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
	ollamaURL     atomic.Pointer[string] // overrides Options.OllamaBaseURL (SetOllama)
	smallModel    atomic.Pointer[string] // overrides Options.SmallCompletionModel (SetOllama)

	// qmu serializes queue decisions (see queue.go); sendNow marks a project
	// whose running turn was cancelled by SendNow. Lock order: qmu before mu.
	qmu     sync.Mutex
	sendNow map[string]bool
	// steer holds, per project with a running built-in orchestrator turn, the
	// queued messages waiting to be injected at its next tool boundary.
	steerMu sync.Mutex
	steer   map[string]*steerBox

	// waiting holds the sessions whose queues may hold a message that can start when a slot frees (qmu).
	waiting map[string]bool

	mu    sync.Mutex
	turns map[string]*turnSlot
	// runs are the sub-agent runs that can be stopped or messaged from their session, by agent id (sessions.go).
	runs map[string]*agentRun
	// live: a turn started and its turn.finished is not published yet (see finish).
	live   map[string]bool
	sides  map[string]*side
	bridge string
	// defaultHook is called after a project's default session changed (OnDefaultChanged).
	defaultHook func(pid string)
}

func New(store *projectstore.Store, hub *events.Hub, notes NoteBook, opts Options) *Orchestrator {
	ctx, stop := context.WithCancel(context.Background())
	o := &Orchestrator{
		store: store, hub: hub, notes: notes, opts: opts, acp: newACPHost(opts.ACPIdle), side: newSideHost(),
		baseCtx: ctx, stop: stop, turns: make(map[string]*turnSlot), live: make(map[string]bool), sides: make(map[string]*side),
		waiting:  make(map[string]bool),
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
	if opts.OllamaBaseURL != "" {
		u := opts.OllamaBaseURL
		o.ollamaURL.Store(&u)
	}
	if opts.SmallCompletionModel != "" {
		m := opts.SmallCompletionModel
		o.smallModel.Store(&m)
	}
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

// turnSlot is what holds a session's turn slot: a turn (counted against the running caps) or an operation that
// must not overlap one (clear, compact).
type turnSlot struct {
	cancel  context.CancelFunc
	counted bool
}

// skey is the key of a main session's per-session state.
func skey(pid, sid string) string { return pid + "/" + sid }

func splitKey(k string) (pid, sid string) {
	pid, sid, _ = strings.Cut(k, "/")
	return pid, sid
}

func ofProject(k, pid string) bool { return strings.HasPrefix(k, pid+"/") }

// Running reports whether any session of the project holds its turn slot.
func (o *Orchestrator) Running(projectID string) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	for k := range o.turns {
		if ofProject(k, projectID) {
			return true
		}
	}
	return false
}

// RunningSession reports whether a main session holds its turn slot.
func (o *Orchestrator) RunningSession(projectID, sessionID string) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	_, ok := o.turns[skey(projectID, sessionID)]
	return ok
}

// RunningCount is how many main sessions run a turn: in the project and on the whole harness.
func (o *Orchestrator) RunningCount(projectID string) (project, total int) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.countLocked(projectID)
}

func (o *Orchestrator) countLocked(projectID string) (project, total int) {
	for k, t := range o.turns {
		if !t.counted {
			continue
		}
		total++
		if ofProject(k, projectID) {
			project++
		}
	}
	return project, total
}

// Cancel aborts every running turn of the project (POST /cancel?all=true, shutdown paths).
func (o *Orchestrator) Cancel(projectID string) {
	o.mu.Lock()
	var cancels []context.CancelFunc
	for k, t := range o.turns {
		if ofProject(k, projectID) {
			cancels = append(cancels, t.cancel)
		}
	}
	o.mu.Unlock()
	for _, c := range cancels {
		c()
	}
}

// CancelSession aborts a main session's running turn, if any ("": the default session).
func (o *Orchestrator) CancelSession(ctx context.Context, projectID, sessionID string) error {
	sid, err := o.resolveSession(ctx, projectID, sessionID)
	if err != nil {
		return err
	}
	o.mu.Lock()
	t := o.turns[skey(projectID, sid)]
	o.mu.Unlock()
	if t != nil {
		t.cancel()
	}
	return nil
}

// resolveSession turns "" into the project's default session.
func (o *Orchestrator) resolveSession(ctx context.Context, pid, sid string) (string, error) {
	if sid != "" {
		return sid, nil
	}
	db, err := o.store.Get(ctx, pid)
	if err != nil {
		return "", err
	}
	return db.DefaultSessionID(ctx)
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

// Start persists the user's message and runs the turn in the background (in the default session).
func (o *Orchestrator) Start(ctx context.Context, projectID, text string) (projectstore.Message, error) {
	return o.StartWith(ctx, projectID, text, StartOpts{})
}

// StartWith is Start with the turn's session ("": the default), mode and an optional pinned plan.
// ErrTurnInProgress while the session runs a turn; ErrNoSlot when the running caps are reached.
func (o *Orchestrator) StartWith(ctx context.Context, projectID, text string, opts StartOpts) (projectstore.Message, error) {
	if o.baseCtx.Err() != nil {
		return projectstore.Message{}, ErrShuttingDown
	}
	db, err := o.store.Get(ctx, projectID)
	if err != nil {
		return projectstore.Message{}, err
	}
	sid := opts.SessionID
	if sid == "" {
		if sid, err = db.DefaultSessionID(ctx); err != nil {
			return projectstore.Message{}, err
		}
	}
	key := skey(projectID, sid)
	turnCtx, cancel := context.WithCancel(o.baseCtx)
	if err := o.claimTurn(key, cancel, o.projectCap(ctx, db)); err != nil {
		cancel()
		return projectstore.Message{}, err
	}
	msg, rt, orch, err := o.begin(ctx, db, sid, text, opts)
	if err != nil {
		cancel()
		o.release(key)
		return projectstore.Message{}, err
	}
	// A built-in turn can take steered messages from the moment it is claimed
	// until it is finished (an ACP turn never can).
	closeBox := func() {}
	if !rt.isACPOrchestrator() {
		closeBox = o.openSteerBox(key)
	}
	o.wg.Add(1)
	go func() {
		defer o.wg.Done()
		defer cancel()
		stopAlive := o.keepAlive(rt)
		status, finished := o.runTurn(turnCtx, rt, orch)
		stopAlive()
		o.qmu.Lock()
		closeBox()
		finished["session_id"], finished["agent_id"] = sid, orch.ID
		// NEW-10: the session's state as it is once the turn is over goes out right after turn.finished. The
		// update runTurn published still said working (the session was live then); a client that shows Stop from
		// the session's state kept it until some later event.
		o.finish(key, finished, o.endedView(db, sid))
		o.advance(projectID, sid, status)
		o.qmu.Unlock()
	}()
	return msg, nil
}

// turnAliveEvery is how often a running turn records that it is alive
// (projectstore.TurnAlive): what a turn cut by a crash during a long tool call
// is said to have run for, to within this much. One tiny write per project
// every few seconds, only while a turn runs.
var turnAliveEvery = 5 * time.Second

// keepAlive records the turn as alive now and every turnAliveEvery until the
// returned stop is called.
func (o *Orchestrator) keepAlive(rt *runtime) (stop func()) {
	beat := func() {
		c, cancel := dbCtx(context.Background())
		defer cancel()
		if err := rt.db.TurnAlive(c); err != nil {
			rt.logErr("record the turn alive", err)
		}
	}
	beat()
	done := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		t := time.NewTicker(turnAliveEvery)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				beat()
			}
		}
	}()
	return func() { close(done); wg.Wait() }
}

// claim takes a session's slot for an operation that is not a turn (clear, compact): it does not count against
// the running caps. False while the session holds its slot.
func (o *Orchestrator) claim(key string, cancel context.CancelFunc) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	if _, ok := o.turns[key]; ok {
		return false
	}
	o.turns[key] = &turnSlot{cancel: cancel}
	o.live[key] = true
	return true
}

// claimTurn takes a session's slot for a turn: ErrTurnInProgress while the session holds it, ErrNoSlot when the
// project runs projectCap turns or the harness MaxRunning.
func (o *Orchestrator) claimTurn(key string, cancel context.CancelFunc, projectCap int) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	if _, ok := o.turns[key]; ok {
		return ErrTurnInProgress
	}
	pid, _ := splitKey(key)
	inProject, total := o.countLocked(pid)
	if inProject >= projectCap || total >= o.machineCap() {
		return ErrNoSlot
	}
	o.turns[key] = &turnSlot{cancel: cancel, counted: true}
	o.live[key] = true
	return nil
}

func (o *Orchestrator) machineCap() int {
	if o.opts.MaxRunning > 0 {
		return o.opts.MaxRunning
	}
	return config.DefaultMaxRunningSessions
}

// hasSlot reports whether a turn of the project could start now under the running caps.
func (o *Orchestrator) hasSlot(pid string, projectCap int) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	inProject, total := o.countLocked(pid)
	return inProject < projectCap && total < o.machineCap()
}

func (o *Orchestrator) release(key string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	delete(o.turns, key)
	delete(o.live, key)
}

// finish ends a turn for the outside world in one step: the turn slot is
// released (a client that reacts to turn.finished can start the next turn),
// turn.finished is published, and the session stops being Active. All three
// happen under o.mu, which Active also takes, so nobody can see the session as
// idle (the agent row says idle before this) without turn.finished already
// published: a client that polls for idle and then subscribes would otherwise
// catch the previous turn's turn.finished as the next turn's.
func (o *Orchestrator) finish(key string, finished, session map[string]any) {
	o.mu.Lock()
	defer o.mu.Unlock()
	delete(o.turns, key)
	pid, _ := splitKey(key)
	o.hub.Publish(pid, events.TurnFinished, finished)
	if session != nil {
		// Under o.mu: an operation that claims the slot next (a clear) publishes after this, never before.
		o.hub.Publish(pid, events.SessionUpdated, session)
	}
	delete(o.live, key)
}

// Active reports whether a turn of the project has started and its turn.finished has not been published yet
// (any session). A project in that state is reported as running whatever its root agents' rows say.
func (o *Orchestrator) Active(projectID string) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	for k := range o.live {
		if ofProject(k, projectID) {
			return true
		}
	}
	return false
}

// ActiveSession is Active for one main session.
func (o *Orchestrator) ActiveSession(projectID, sessionID string) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.live[skey(projectID, sessionID)]
}

func (o *Orchestrator) begin(ctx context.Context, db *projectstore.DB, sid, text string, opts StartOpts) (projectstore.Message, *runtime, projectstore.Agent, error) {
	orch, err := db.RootAgent(ctx, sid)
	if err != nil {
		return projectstore.Message{}, nil, projectstore.Agent{}, err
	}
	o.memoryOf(db) // installs the secret redactor of the search index before anything is indexed
	rt, err := o.newSessionRuntime(ctx, db, sid)
	if err != nil {
		return projectstore.Message{}, nil, projectstore.Agent{}, err
	}
	if err := rt.repairDangling(ctx, orch.ID); err != nil {
		return projectstore.Message{}, nil, projectstore.Agent{}, err
	}
	if err := db.UnarchiveSession(ctx, sid); err != nil {
		return projectstore.Message{}, nil, projectstore.Agent{}, err
	}
	// A retry sends the text of a turn that failed before it answered: the
	// stored user message is run again, not stored a second time.
	msg, retried := rt.failedRequest(ctx, orch, text)
	reportNote := ""
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
		status, problem = projectstore.StatusFailed, o.describeTurn(err)
		slog.Error("turn failed", "project", rt.pid(), "err", err)
	}
	if status == projectstore.StatusCancelled && !rt.isACPOrchestrator() {
		// The calls the stop interrupted get their result now, at the stop, not
		// before the next request: a reload then shows the stopped step and
		// the turn's end as it was seen live. (An ACP turn closes its open
		// calls itself, acp_session.go finishLocked.)
		c, cancel := dbCtx(context.Background())
		if err := rt.repairDangling(c, orch.ID); err != nil {
			rt.logErr("close interrupted tool calls", err)
		}
		cancel()
	}
	if status == projectstore.StatusCompleted && rt.isACPOrchestrator() {
		// A notice, not a failure: the session works without harness tools.
		notice = o.acp.warning(rt.key())
	}
	o.approvals.EndTurn(rt.pid(), rt.turnID)
	if status == projectstore.StatusCompleted && rt.mode == projectstore.ModePlan {
		rt.turnPlan.Store(true)
		o.savePlan(rt, res.Text)
	}
	finished := rt.finishTurn(orch.ID, status, res.Text, problem, notice)
	rt.publish(events.ContextUpdated, map[string]any{"project_id": rt.pid()})
	o.recordExchange(rt, orch.ID, status, res.Text, problem)
	rt.publishSession(rt.sessionID, false)
	o.settleTurn(rt, orch.ID, status, res.Text)
	return status, finished
}
