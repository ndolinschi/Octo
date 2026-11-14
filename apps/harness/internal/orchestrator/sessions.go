package orchestrator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
	"github.com/ndolinschi/Octo/apps/harness/internal/changes"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// ReportCommand marks the stored user message that hands a sub-agent session's answer to the orchestrator
// ("report_to_parent"); the transcript shows it as a quiet note, not as something the person typed.
const ReportCommand = "session_report"

// SessionError is a refusal of a session operation with a stable code (the bridge answers 409 with it).
type SessionError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Hint    string `json:"hint,omitempty"`
	// User is the catalogue form (plain message and hint, technical details).
	User *usererr.Error `json:"-"`
}

func (e *SessionError) Error() string { return e.Code + ": " + e.Message }

// sessionErr refuses with the catalogue's plain wording for code; why is a
// plain reason for not_continuable and details the technical text.
func sessionErr(code, why, details string) *SessionError {
	return sessionUser(usererr.SessionRefused(code, why, details))
}

func withCode(u *usererr.Error, code string) *usererr.Error {
	c := *u
	c.Code = code
	return &c
}

func sessionUser(u *usererr.Error) *SessionError {
	return &SessionError{Code: u.Code, Message: u.Message, Hint: u.Hint, User: u}
}

// SessionView is a session as the API shows it: the stored fields with the live state, and, for the sessions
// that take a message, whether one can be sent now and why not.
type SessionView struct {
	projectstore.SessionInfo
	// CanMessage: a message can be sent to this session now (POST /sessions/{sid}/messages). MessageBlocked says
	// why not.
	CanMessage     bool          `json:"can_message"`
	MessageBlocked *SessionError `json:"message_blocked,omitempty"`
	// Main sessions: what waits for the person in this session (approvals and forms of its turns).
	NeedsYou         bool `json:"needs_you"`
	PendingApprovals int  `json:"pending_approvals"`
	PendingInputs    int  `json:"pending_inputs"`
}

// agentRun is a sub-agent run the user can stop and, while it is a built-in one, steer.
type agentRun struct {
	cancel context.CancelFunc
	// detached: started by the user from its session, outside any turn, so a turn's end leaves it running.
	detached bool
	box      *agentBox
}

// agentBox holds the texts sent to a running built-in sub-agent; it takes them at its next tool boundary.
type agentBox struct {
	mu     sync.Mutex
	texts  []string
	closed bool
}

func (b *agentBox) add(text string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return false
	}
	b.texts = append(b.texts, text)
	return true
}

func (b *agentBox) take() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := b.texts
	b.texts = nil
	return out
}

// close ends the box and returns the texts nobody took.
func (b *agentBox) close() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.closed = true
	out := b.texts
	b.texts = nil
	return out
}

// registerRun records a running sub-agent (cancel for Stop, a steer box for a built-in one) and returns the
// function that ends the registration and hands back the texts that arrived too late to be taken.
func (o *Orchestrator) registerRun(agentID string, cancel context.CancelFunc, steerable, detached bool) func() []string {
	r := &agentRun{cancel: cancel, detached: detached}
	if steerable {
		r.box = &agentBox{}
	}
	o.mu.Lock()
	if o.runs == nil {
		o.runs = map[string]*agentRun{}
	}
	o.runs[agentID] = r
	o.mu.Unlock()
	return func() []string {
		o.mu.Lock()
		if o.runs[agentID] == r {
			delete(o.runs, agentID)
		}
		o.mu.Unlock()
		if r.box != nil {
			return r.box.close()
		}
		return nil
	}
}

func (o *Orchestrator) runOf(agentID string) *agentRun {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.runs[agentID]
}

// steerTextsOf is the loop's Steer hook of a sub-agent.
func (o *Orchestrator) steerTextsOf(agentID string) func(context.Context) []string {
	return func(context.Context) []string {
		if r := o.runOf(agentID); r != nil && r.box != nil {
			return r.box.take()
		}
		return nil
	}
}

// SessionView adds the live state to a stored session.
func (o *Orchestrator) SessionView(ctx context.Context, db *projectstore.DB, info projectstore.SessionInfo) SessionView {
	v := SessionView{SessionInfo: info}
	if info.Kind == projectstore.KindMain {
		v.PendingApprovals, v.PendingInputs = o.SessionAttention(db.ID(), info.ID)
		v.NeedsYou = v.PendingApprovals+v.PendingInputs > 0
		switch {
		case o.ActiveSession(db.ID(), info.ID):
			v.State = projectstore.SessionWorking
			if v.NeedsYou {
				v.State = projectstore.SessionWaiting
			}
		case info.Queued > 0 && !info.QueuePaused:
			v.State = projectstore.SessionQueued
		}
		if blocked := o.mainMessageBlock(ctx, db, info); blocked != nil {
			v.MessageBlocked = blocked
		} else {
			v.CanMessage = true
		}
		return v
	}
	if blocked := o.agentMessageBlock(ctx, db, info); blocked != nil {
		v.MessageBlocked = blocked
	} else {
		v.CanMessage = true
	}
	return v
}

// mainMessageBlock says why a main session cannot take a message (nil: it can): only when the orchestrator it
// runs on needs the built-in loop and that is unavailable.
func (o *Orchestrator) mainMessageBlock(ctx context.Context, db *projectstore.DB, info projectstore.SessionInfo) *SessionError {
	why := o.builtinOff()
	if why == "" {
		return nil
	}
	c, cancel := dbCtx(ctx)
	defer cancel()
	rt, err := o.newSessionRuntime(c, db, info.ID)
	if err != nil || rt.isACPOrchestrator() {
		return nil
	}
	return sessionErr("builtin_loop_unavailable", "", why)
}

// agentMessageBlock says why a message cannot be sent to an agent session now (nil: it can).
func (o *Orchestrator) agentMessageBlock(ctx context.Context, db *projectstore.DB, info projectstore.SessionInfo) *SessionError {
	a, err := db.Agent(ctx, info.AgentID)
	if err != nil {
		return sessionErr("not_continuable", "The agent was removed.", "agent row missing")
	}
	acpAgent := plugins.IsACPRef(a.Model)
	if a.Status == projectstore.StatusRunning {
		if acpAgent {
			return sessionErr("steer_unsupported", "", "an ACP prompt that is running takes no added input")
		}
		if r := o.runOf(a.ID); r == nil || r.box == nil {
			return sessionErr("not_running", "", "no steerable run")
		}
		return nil
	}
	if !acpAgent {
		if why := o.builtinOff(); why != "" {
			return sessionErr("builtin_loop_unavailable", "", why)
		}
		if msgs, err := db.Messages(ctx, a.ID); err != nil || len(msgs) == 0 {
			return sessionErr("not_continuable", "It kept no conversation to continue.", "no stored messages")
		}
		return nil
	}
	if _, ok, err := db.SessionACPOf(ctx, info.ID); err != nil || !ok {
		return sessionErr("not_continuable", "It ran before sessions were kept, or never opened one.", "no stored ACP session")
	}
	return nil
}

// publishSession announces a session's current state (session.updated, or session.created with created).
func (o *Orchestrator) publishSession(ctx context.Context, db *projectstore.DB, id string, created bool) {
	c, cancel := dbCtx(ctx)
	defer cancel()
	info, err := db.SessionInfoOf(c, id)
	if err != nil {
		return
	}
	typ := events.SessionUpdated
	if created {
		typ = events.SessionCreated
	}
	o.hub.Publish(db.ID(), typ, map[string]any{"session": o.SessionView(c, db, info)})
}

func (rt *runtime) publishSession(id string, created bool) {
	rt.o.publishSession(context.Background(), rt.db, id, created)
}

// registerAgentSession creates the session of a sub-agent, linked to the main session and the turn that
// spawned it, and announces it.
func (rt *runtime) registerAgentSession(ctx context.Context, a projectstore.Agent) {
	c, cancel := dbCtx(ctx)
	defer cancel()
	parent := rt.sessionID
	info, err := rt.db.CreateAgentSession(c, a, parent, rt.turnID)
	if err != nil {
		rt.logErr("create agent session", err)
		return
	}
	rt.o.hub.Publish(rt.pid(), events.SessionCreated, map[string]any{"session": rt.o.SessionView(c, rt.db, info)})
}

// ---- new session, default ----

// NewSessionInput is POST /sessions (spec 2026-11-14 section 8): a main session, not the default unless
// MakeDefault; with FromSessionID and Clear it is /clear of that session.
type NewSessionInput struct {
	Title       string
	Memory      string // "project", "on", "read", "off" ("": project)
	Model       string
	Mode        string
	MakeDefault bool
	FromSession string
	Clear       bool
}

// NewSession starts a new main session with an optional title, made the default: the same as /clear of the
// default session (the old one is summarised and kept), then the title. ErrTurnInProgress while that session runs.
func (o *Orchestrator) NewSession(ctx context.Context, pid, title string) (SessionView, error) {
	return o.CreateSession(ctx, pid, NewSessionInput{Title: title, Clear: true, MakeDefault: true})
}

// CreateSession creates a main session. Without Clear it is empty (no carry-over), in the shared workspace, with
// the memory mode asked for (the project's default for "project" or ""), the default only with MakeDefault.
// With Clear it is /clear of FromSession ("": the default): the session gets that session's carry-over, workspace
// and memory mode, and is the default when that one was.
func (o *Orchestrator) CreateSession(ctx context.Context, pid string, in NewSessionInput) (SessionView, error) {
	db, err := o.store.Get(ctx, pid)
	if err != nil {
		return SessionView{}, err
	}
	var sid string
	if in.Clear {
		res, err := o.ClearSession(ctx, pid, in.FromSession)
		if err != nil {
			return SessionView{}, err
		}
		sid = res.SessionID
		if sid == "" {
			if sid, err = db.DefaultSessionID(ctx); err != nil {
				return SessionView{}, err
			}
		}
		if t := strings.TrimSpace(in.Title); t != "" {
			if _, err := db.PatchSession(ctx, sid, &t, nil); err != nil {
				return SessionView{}, err
			}
		}
		if in.Model != "" || in.Mode != "" {
			if err := db.SetSessionSettings(ctx, sid, in.Model, optional(in.Mode), nil); err != nil {
				return SessionView{}, err
			}
		}
		if in.MakeDefault {
			if _, err := o.SetDefaultSession(ctx, pid, sid); err != nil {
				return SessionView{}, err
			}
		}
		o.publishSession(ctx, db, sid, false)
	} else {
		memory := in.Memory
		if memory == "" || memory == "project" {
			memory = projectstore.MemoryOn // every project's memory.new_sessions is "on" until memory modes are built
		}
		info, prev, err := db.CreateMainSession(ctx, projectstore.NewMainSession{
			Title: strings.TrimSpace(in.Title), Model: in.Model, Mode: in.Mode, Memory: memory, MakeDefault: in.MakeDefault,
		})
		if err != nil {
			return SessionView{}, err
		}
		sid = info.ID
		if root, err := db.Agent(ctx, info.RootAgentID); err == nil {
			o.hub.Publish(pid, events.AgentCreated, map[string]any{"agent": root, "session_id": sid})
		}
		o.publishSession(ctx, db, sid, true)
		if prev != "" && prev != sid {
			o.defaultChanged(ctx, db, prev, sid)
		}
	}
	info, err := db.SessionInfoOf(ctx, sid)
	if err != nil {
		return SessionView{}, err
	}
	return o.SessionView(ctx, db, info), nil
}

func optional(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// ResumeSession is the old name of SetDefaultSession (POST /sessions/{sid}/resume is an alias of /default).
func (o *Orchestrator) ResumeSession(ctx context.Context, pid, sid string) (SessionView, error) {
	return o.SetDefaultSession(ctx, pid, sid)
}

// SetDefaultSession makes a main session the default: what is sent to the project without a session goes to it
// from now on. Nothing is stopped or rebuilt (every session keeps its own root agent, conversation and ACP
// session); an archived session is unarchived. ErrNotFound for an unknown session, not_main_session for an agent
// session.
func (o *Orchestrator) SetDefaultSession(ctx context.Context, pid, sid string) (SessionView, error) {
	db, err := o.store.Get(ctx, pid)
	if err != nil {
		return SessionView{}, err
	}
	info, err := db.SessionInfoOf(ctx, sid)
	if err != nil {
		return SessionView{}, err
	}
	if info.Kind != projectstore.KindMain {
		return SessionView{}, sessionErr("not_main_session", "", "kind is agent")
	}
	if !info.Default {
		if _, err := db.RootAgent(ctx, sid); err != nil { // a session from before schema 15 gets its root now
			return SessionView{}, err
		}
		prev, err := db.SetCurrentSession(ctx, sid)
		if err != nil {
			return SessionView{}, err
		}
		o.defaultChanged(ctx, db, prev, sid)
	}
	info, err = db.SessionInfoOf(ctx, sid)
	if err != nil {
		return SessionView{}, err
	}
	return o.SessionView(ctx, db, info), nil
}

// OnDefaultChanged sets what is called after a project's default session changed (the project service
// republishes the project, whose orchestrator_agent_id is the default session's root).
func (o *Orchestrator) OnDefaultChanged(f func(pid string)) {
	o.mu.Lock()
	o.defaultHook = f
	o.mu.Unlock()
}

// defaultChanged announces a new default session: session.default, then session.current (its old name), both
// sessions, the context, and the project.
func (o *Orchestrator) defaultChanged(ctx context.Context, db *projectstore.DB, prev, sid string) {
	pid := db.ID()
	o.hub.Publish(pid, events.SessionDefault, map[string]any{"session_id": sid, "previous_session_id": prev})
	o.hub.Publish(pid, events.SessionCurrent, map[string]any{"session_id": sid, "previous_session_id": prev})
	if prev != "" {
		o.publishSession(ctx, db, prev, false)
	}
	o.publishSession(ctx, db, sid, false)
	o.hub.Publish(pid, events.ContextUpdated, map[string]any{"project_id": pid, "session_id": sid})
	o.hub.Publish(pid, events.SlashCommandsUpdated, map[string]any{"project_id": pid})
	o.mu.Lock()
	hook := o.defaultHook
	o.mu.Unlock()
	if hook != nil {
		hook(pid)
	}
}

// keepAgentSession remembers the ACP session a sub-agent opened, so its session can be continued later.
func (rt *runtime) keepAgentSession(ctx context.Context, agentID, plugin, model, acpSessionID string) {
	c, cancel := dbCtx(ctx)
	defer cancel()
	info, err := rt.db.SessionOfAgent(c, agentID)
	if err == nil {
		err = rt.db.SetSessionACP(c, info.ID, projectstore.SessionACP{Agent: plugin, Model: model, SessionID: acpSessionID})
	}
	if err != nil {
		rt.logErr("remember sub-agent acp session", err)
	}
}

// noteACPSession remembers the agent session an ACP orchestrator opened for the turn's main session.
func (rt *runtime) noteACPSession(ctx context.Context, plugin, model, sessionID string) {
	c, cancel := dbCtx(ctx)
	defer cancel()
	sid, err := rt.sessionID, error(nil)
	if sid == "" {
		sid, err = rt.db.DefaultSessionID(c)
	}
	if err == nil {
		err = rt.db.SetSessionACP(c, sid, projectstore.SessionACP{Agent: plugin, Model: model, SessionID: sessionID})
	}
	if err != nil {
		rt.logErr("remember acp session", err)
	}
}

// ---- stop, message ----

// StopSession stops what a session runs: a main session's running turn (its queue is paused by the cancel) or
// one sub-agent. A session that is not running is a SessionError not_running.
func (o *Orchestrator) StopSession(ctx context.Context, pid, sid string) (SessionView, error) {
	db, err := o.store.Get(ctx, pid)
	if err != nil {
		return SessionView{}, err
	}
	info, err := db.SessionInfoOf(ctx, sid)
	if err != nil {
		return SessionView{}, err
	}
	switch {
	case info.Kind == projectstore.KindMain && o.ActiveSession(pid, sid):
		_ = o.CancelSession(ctx, pid, sid)
	case info.Kind == projectstore.KindAgent && o.runOf(info.AgentID) != nil:
		o.runOf(info.AgentID).cancel()
	default:
		return SessionView{}, sessionErr("not_running", "", "")
	}
	return o.SessionView(ctx, db, info), nil
}

// MessageOutcome says what became of a message sent to an agent session.
type MessageOutcome string

const (
	// Steered: the running agent takes the text at its next tool boundary.
	Steered MessageOutcome = "steered"
	// Continued: the finished agent was resumed with the text and runs again.
	Continued MessageOutcome = "continued"
)

// MessageAgentSession sends a message to a sub-agent's session. While the agent runs (a built-in one) the
// text is steered into it; after it finished it is continued: a built-in agent from its stored messages, an
// ACP agent in its kept session (session/load). A refusal is a *SessionError. With reportToParent the
// answer is handed to the orchestrator as a note at the start of its next turn (the answer of a running
// agent already goes to the orchestrator as the delegation's result).
func (o *Orchestrator) MessageAgentSession(ctx context.Context, pid, sid, text string, reportToParent bool) (MessageOutcome, SessionView, error) {
	db, err := o.store.Get(ctx, pid)
	if err != nil {
		return "", SessionView{}, err
	}
	info, err := db.SessionInfoOf(ctx, sid)
	if err != nil {
		return "", SessionView{}, err
	}
	if info.Kind != projectstore.KindAgent {
		return "", SessionView{}, sessionErr("not_agent_session", "", "kind is main")
	}
	if blocked := o.agentMessageBlock(ctx, db, info); blocked != nil {
		return "", SessionView{}, blocked
	}
	a, err := db.Agent(ctx, info.AgentID)
	if err != nil {
		return "", SessionView{}, err
	}
	out := Continued
	if a.Status == projectstore.StatusRunning {
		r := o.runOf(a.ID)
		if r == nil || r.box == nil || !r.box.add(text) {
			return "", SessionView{}, sessionErr("not_running", "", "the run finished before the message was taken")
		}
		out = Steered
	} else if err := o.continueAgent(ctx, db, a, info, text, reportToParent); err != nil {
		return "", SessionView{}, err
	}
	c, cancel := dbCtx(ctx)
	defer cancel()
	fresh, err := db.SessionInfoOf(c, sid)
	if err != nil {
		return out, SessionView{}, err
	}
	return out, o.SessionView(c, db, fresh), nil
}

// continueAgent starts the finished agent again with text, outside any turn.
func (o *Orchestrator) continueAgent(ctx context.Context, db *projectstore.DB, a projectstore.Agent, info projectstore.SessionInfo, text string, report bool) error {
	if o.baseCtx.Err() != nil {
		return ErrShuttingDown
	}
	rt, err := o.newRuntime(ctx, db)
	if err != nil {
		return err
	}
	rt.turnID, rt.sessionID = info.TurnID, info.ParentSessionID
	runCtx, cancel := context.WithCancel(o.baseCtx)
	started := false
	defer func() {
		if !started {
			cancel()
		}
	}()
	var ext *acpTarget
	var kept projectstore.SessionACP
	var client *acp.Client
	if id, m, ok := plugins.ParseACPRef(a.Model); ok {
		t, msg := rt.pickACPAgent(id, m)
		if msg != "" {
			return sessionErr("not_continuable", "That agent is not available right now.", msg)
		}
		ext = &t
		var have bool
		if kept, have, err = db.SessionACPOf(ctx, info.ID); err != nil {
			return err
		} else if !have {
			return sessionErr("not_continuable", "It never opened a session that can be resumed.", "no stored ACP session")
		}
		// Start the process and load the session now, so a refusal is the answer to this request.
		c, err := acp.Start(runCtx, acp.Spec{Command: t.agent.Command, Args: t.agent.ArgsFor(t.model), Env: t.processEnv(), Dir: rt.folders[0].Path, Name: t.agent.ID, Redact: rt.redact})
		if err != nil {
			return sessionUser(withCode(usererr.Of(startFailure(t, err)), "not_continuable"))
		}
		if !c.Capabilities().LoadSession {
			c.Close()
			return sessionErr("not_continuable", t.agent.Label+" cannot reopen a finished session.", "no session/load capability")
		}
		if err := c.LoadSession(runCtx, kept.SessionID, rt.folders[0].Path, nil); err != nil {
			c.Close()
			return sessionErr("not_continuable", t.agent.Label+" could not reopen the session.", rt.redact(err.Error()))
		}
		client = c
	}
	if len(rt.folders) == 0 && ext != nil {
		return sessionErr("not_continuable", "This agent needs a project folder, and the project has none.", "no folders attached")
	}
	// The agent row runs again; the user's message is stored in its transcript first.
	task := anthropic.NewUserMessage(anthropic.NewTextBlock(text))
	sink := &agentSink{rt: rt, agentID: a.ID}
	if ext == nil {
		if err := rt.repairDangling(ctx, a.ID); err != nil {
			return err
		}
	}
	if err := sink.Message(ctx, "user", task); err != nil {
		if client != nil {
			client.Close()
		}
		return err
	}
	running, now := projectstore.StatusRunning, projectstore.Now()
	row, err := db.UpdateAgent(ctx, a.ID, projectstore.AgentPatch{Status: &running, StartedAt: &now, Reset: true})
	if err != nil {
		if client != nil {
			client.Close()
		}
		return err
	}
	rt.publishAgent(events.AgentUpdated, row)
	end := o.registerRun(a.ID, cancel, ext == nil, true)
	started = true
	o.wg.Add(1)
	go func() {
		defer o.wg.Done()
		defer cancel()
		var final string
		var runErr error
		if ext != nil {
			final, runErr = rt.runACPLoaded(runCtx, row, *ext, client, kept.SessionID, text)
		} else {
			var res string
			res, runErr = rt.runChild(runCtx, row, task, nil)
			final = res
		}
		left := end()
		rt.settleRun(row, info, final, runErr, runCtx.Err() != nil, report)
		if len(left) > 0 {
			// Texts that arrived after the last tool boundary run as the next continuation.
			next := strings.Join(left, "\n\n")
			if err := o.continueAgentByID(pid(db), a.ID, next, report); err != nil {
				slog.Warn("continue agent with late messages", "agent", a.ID, "err", err)
			}
		}
	}()
	return nil
}

func pid(db *projectstore.DB) string { return db.ID() }

// continueAgentByID is continueAgent for a caller that holds only ids (texts left over when a run ended).
func (o *Orchestrator) continueAgentByID(pid, agentID, text string, report bool) error {
	ctx := context.Background()
	db, err := o.store.Get(ctx, pid)
	if err != nil {
		return err
	}
	a, err := db.Agent(ctx, agentID)
	if err != nil {
		return err
	}
	info, err := db.SessionOfAgent(ctx, agentID)
	if err != nil {
		return err
	}
	return o.continueAgent(ctx, db, a, info, text, report)
}

// settleRun records how a continued run ended and, when asked, leaves its answer for the orchestrator.
func (rt *runtime) settleRun(a projectstore.Agent, info projectstore.SessionInfo, text string, err error, cancelled, report bool) {
	ctx := context.Background()
	switch {
	case err == nil:
		rt.settle(ctx, a.ID, projectstore.StatusCompleted, text, "")
	case cancelled || errors.Is(err, errAgentCancelled):
		rt.settle(ctx, a.ID, projectstore.StatusCancelled, "", "")
	default:
		rt.settleProblem(ctx, a.ID, describe(err))
	}
	if report && err == nil && strings.TrimSpace(text) != "" && info.ParentSessionID != "" {
		note := fmt.Sprintf("Sub-agent %q (session %s) answered a message the user sent to it directly:\n%s", a.Title, info.ID, rt.redact(rt.o.opts.Limits.CapReport(text)))
		c, cancel := dbCtx(ctx)
		defer cancel()
		if err := rt.db.AddSessionReport(c, info.ParentSessionID, info.ID, note); err != nil {
			rt.logErr("queue session report", err)
		}
	}
}

// runACPLoaded runs one prompt on an ACP session that is already loaded on client.
func (rt *runtime) runACPLoaded(ctx context.Context, child projectstore.Agent, t acpTarget, client *acp.Client, sessionID, text string) (string, error) {
	ag := t.agent
	defer client.Close()
	defer rt.o.adv.running(ag.ID)()
	h := newACPSession(rt, child.ID, ag.ID, child.Model)
	h.flat = ag.FlatRateIn(t.processEnv())
	endSpan := rt.trackSpan(ctx, child.ID, "", changes.SourceACPTurn)
	defer endSpan()
	stop, err := client.Prompt(ctx, sessionID, text, h)
	h.finish(ctx, err != nil)
	if err != nil {
		return "", acpFailure(ag, false, err)
	}
	switch stop {
	case acp.StopEndTurn:
		if h.nothing() {
			return "", nothingError(ag)
		}
		return h.finalText(), nil
	case acp.StopCancelled:
		return "", errAgentCancelled
	}
	return "", stopError(ag, stop)
}

// ---- reports ----

// pendingReportNote takes the notes agent sessions left for the main session and stores them as one quiet message
// before the request, so the orchestrator (built-in loop or ACP agent) sees them at the start of this turn.
// It returns the note's text ("" when there was none).
func (rt *runtime) pendingReportNote(ctx context.Context, orchID string) string {
	c, cancel := dbCtx(ctx)
	defer cancel()
	sid := rt.sessionID
	if sid == "" {
		var err error
		if sid, err = rt.db.DefaultSessionID(c); err != nil {
			return ""
		}
	}
	reports, err := rt.db.TakeSessionReports(c, sid)
	if err != nil || len(reports) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("[Results the user collected from sub-agent sessions since your last turn]\n")
	for _, r := range reports {
		b.WriteString("\n" + r.Text + "\n")
	}
	text := strings.TrimSpace(b.String())
	body, _ := json.Marshal([]map[string]any{{"type": "text", "text": text}})
	m, err := rt.db.AppendMessageCommand(c, orchID, "user", body, ReportCommand)
	if err != nil {
		rt.logErr("store session report note", err)
		return ""
	}
	rt.publish(events.MessageCreated, map[string]any{"message": m})
	return text
}
