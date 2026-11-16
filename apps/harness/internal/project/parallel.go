package project

import (
	"context"
	"errors"
	"slices"
	"strconv"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/approval"
	"github.com/ndolinschi/Octo/apps/harness/internal/changes"
	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/inputs"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// Parallel sessions (spec 2026-11-14-parallel-sessions-design.md, phase 1): every main session is addressable.
// The routes under /sessions/{sid} act on one session; the project-level routes of the same name act on the
// default session (sid "").

// SessionTurns is the part of the orchestrator the session routes drive.
type SessionTurns interface {
	SubmitSession(ctx context.Context, pid, sid, text, mode string, attachments []string) (projectstore.Message, *projectstore.QueuedMessage, error)
	CancelSession(ctx context.Context, pid, sid string) error
	RunningSession(pid, sid string) bool
	ActiveSession(pid, sid string) bool
	SessionQueue(ctx context.Context, pid, sid string) ([]projectstore.QueuedMessage, bool, error)
	EditSessionQueued(ctx context.Context, pid, sid, qid, text string) (projectstore.QueuedMessage, error)
	RemoveSessionQueued(ctx context.Context, pid, sid, qid string) error
	ResumeSessionQueue(ctx context.Context, pid, sid string) error
	SendNowSession(ctx context.Context, pid, sid, qid string, interrupt bool) (bool, error)
	CreateSession(ctx context.Context, pid string, in orchestrator.NewSessionInput) (orchestrator.SessionView, error)
	SetDefaultSession(ctx context.Context, pid, sid string) (orchestrator.SessionView, error)
	ClearSession(ctx context.Context, pid, sid string) (orchestrator.ClearResult, error)
	CompactSession(ctx context.Context, pid, sid string) (orchestrator.CompactResult, error)
	RewindSession(ctx context.Context, pid, sid string, messageID int64, dryRun bool) (orchestrator.RewindReport, error)
	LatestSessionPlan(ctx context.Context, pid, sid string) (projectstore.Plan, error)
	SessionsAttention(pid string) []orchestrator.SessionNeed
	OnDefaultChanged(f func(pid string))
	Reschedule()
	CompactViaAgentSession(ctx context.Context, pid, sid string) (projectstore.Message, bool, error)
	ForgetSession(pid, sid string)
}

// IsMainSession says whether sid is a main session of the project (404 for an unknown session).
func (s *Service) IsMainSession(ctx context.Context, pid, sid string) (bool, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return false, err
	}
	info, err := db.SessionInfoOf(ctx, sid)
	if err != nil {
		return false, sessionErr(err)
	}
	return info.Kind == projectstore.KindMain, nil
}

// CompactViaAgentSession is CompactViaAgent for one main session ("": the default).
func (s *Service) CompactViaAgentSession(ctx context.Context, pid, sid string) (msg projectstore.Message, sent bool, err error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return msg, false, err
	}
	if sid, err = s.mainSessionID(ctx, db, sid); err != nil {
		return msg, false, err
	}
	msg, sent, err = s.sessions().CompactViaAgentSession(ctx, pid, sid)
	switch {
	case errors.Is(err, orchestrator.ErrTurnInProgress):
		return msg, false, turnInProgress()
	case errors.Is(err, orchestrator.ErrNoSlot):
		return msg, false, slotsFull(s, pid)
	case orchestrator.IsNoBuiltinLoop(err):
		return msg, false, of(KindConflict, usererr.BuiltinLoopOff(err.Error()))
	}
	return msg, sent, err
}

// slotsFull is 409 session_slots_full for a turn that cannot wait in a queue (approving a plan, /compact sent to
// an agent).
func slotsFull(s *Service, pid string) error {
	n := 0
	if c, ok := s.turns.(interface{ RunningCount(string) (int, int) }); ok {
		n, _ = c.RunningCount(pid)
	}
	return of(KindConflict, usererr.SessionSlotsFull(n))
}

// mainSessionID resolves "" to the default session and checks that sid is a main session of the project
// (404 session otherwise).
func (s *Service) mainSessionID(ctx context.Context, db *projectstore.DB, sid string) (string, error) {
	if sid == "" {
		id, err := db.DefaultSessionID(ctx)
		return id, storeErr(err)
	}
	info, err := db.SessionInfoOf(ctx, sid)
	if err != nil {
		return "", sessionErr(err)
	}
	if info.Kind != projectstore.KindMain {
		return "", of(KindConflict, usererr.SessionRefused("not_main_session", "", "kind is agent"))
	}
	return sid, nil
}

// announceProject republishes the project (project.updated): its orchestrator_agent_id is the default session's
// root, which changes with the default.
func (s *Service) announceProject(pid string) {
	p, err := s.Get(context.Background(), pid)
	if err != nil {
		return
	}
	s.hub.Publish(pid, events.ProjectUpdated, map[string]any{"project": p})
}

// PostSessionMessage is POST /sessions/{sid}/messages for a main session ("": the default, POST /messages):
// it starts a turn, or queues the message in that session (waiting for its turn, or for a slot when the
// running caps are reached). An archived session is unarchived.
func (s *Service) PostSessionMessage(ctx context.Context, pid, sid, text string, mode *string, attach []string) (msg projectstore.Message, queued *projectstore.QueuedMessage, err error) {
	if len(attach) > 0 && strings.TrimSpace(text) == "" {
		text = defaultImageText
	}
	if strings.TrimSpace(text) == "" {
		return msg, nil, invalid("text is required")
	}
	if err := refuseOctoCommand(text); err != nil {
		return msg, nil, err
	}
	if err := validMode(mode); err != nil {
		return msg, nil, err
	}
	db, err := s.db(ctx, pid)
	if err != nil {
		return msg, nil, err
	}
	if sid, err = s.mainSessionID(ctx, db, sid); err != nil {
		return msg, nil, err
	}
	if len(attach) > 0 {
		if err := s.checkAttachments(ctx, db, pid, attach); err != nil {
			return msg, nil, err
		}
	}
	m := ""
	if mode != nil {
		m = *mode
	}
	msg, queued, err = s.sessions().SubmitSession(ctx, pid, sid, text, m, attach)
	switch {
	case errors.Is(err, orchestrator.ErrQueueFull):
		return msg, nil, queueFull()
	case errors.Is(err, orchestrator.ErrTurnInProgress):
		return msg, nil, turnInProgress()
	case errors.Is(err, projectstore.ErrNotFound):
		return msg, nil, notFound("session")
	}
	if queued != nil {
		if _, err := db.SessionInfoOf(ctx, sid); err == nil {
			_ = db.UnarchiveSession(ctx, sid)
		}
	}
	return msg, queued, storeErr(err)
}

// sessions is the orchestrator's session surface (every Turns is one; *orchestrator.Orchestrator is the only one).
func (s *Service) sessions() SessionTurns { return s.turns.(SessionTurns) }

// CancelSession is POST /sessions/{sid}/cancel: stops a main session's turn ("": the default's).
func (s *Service) CancelSession(ctx context.Context, pid, sid string, all bool) error {
	db, err := s.db(ctx, pid)
	if err != nil {
		return err
	}
	if all {
		s.turns.Cancel(pid)
		return nil
	}
	if sid, err = s.mainSessionID(ctx, db, sid); err != nil {
		return err
	}
	return s.sessions().CancelSession(ctx, pid, sid)
}

// SessionQueueState is GET /sessions/{sid}/queue ("": the default's, GET /queue).
func (s *Service) SessionQueueState(ctx context.Context, pid, sid string) (QueueState, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return QueueState{}, err
	}
	if sid, err = s.mainSessionID(ctx, db, sid); err != nil {
		return QueueState{}, err
	}
	msgs, paused, err := s.sessions().SessionQueue(ctx, pid, sid)
	return QueueState{Paused: paused, Messages: msgs, SessionID: sid}, err
}

// EditSessionQueued is PATCH /sessions/{sid}/queue/{qid}.
func (s *Service) EditSessionQueued(ctx context.Context, pid, sid, qid, text string) (projectstore.QueuedMessage, error) {
	if strings.TrimSpace(text) == "" {
		return projectstore.QueuedMessage{}, invalid("text is required")
	}
	if err := refuseOctoCommand(text); err != nil {
		return projectstore.QueuedMessage{}, err
	}
	db, err := s.db(ctx, pid)
	if err != nil {
		return projectstore.QueuedMessage{}, err
	}
	if sid, err = s.mainSessionID(ctx, db, sid); err != nil {
		return projectstore.QueuedMessage{}, err
	}
	m, err := s.sessions().EditSessionQueued(ctx, pid, sid, qid, text)
	return m, queueErr(err)
}

// RemoveSessionQueued is DELETE /sessions/{sid}/queue[/{qid}].
func (s *Service) RemoveSessionQueued(ctx context.Context, pid, sid, qid string) error {
	db, err := s.db(ctx, pid)
	if err != nil {
		return err
	}
	if sid, err = s.mainSessionID(ctx, db, sid); err != nil {
		return err
	}
	return queueErr(s.sessions().RemoveSessionQueued(ctx, pid, sid, qid))
}

// ResumeSessionQueue is POST /sessions/{sid}/queue/resume.
func (s *Service) ResumeSessionQueue(ctx context.Context, pid, sid string) error {
	db, err := s.db(ctx, pid)
	if err != nil {
		return err
	}
	if sid, err = s.mainSessionID(ctx, db, sid); err != nil {
		return err
	}
	return s.sessions().ResumeSessionQueue(ctx, pid, sid)
}

// SendNowSession is POST /sessions/{sid}/queue/{qid}/send-now.
func (s *Service) SendNowSession(ctx context.Context, pid, sid, qid string, interrupt bool) (bool, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return false, err
	}
	if sid, err = s.mainSessionID(ctx, db, sid); err != nil {
		return false, err
	}
	steered, err := s.sessions().SendNowSession(ctx, pid, sid, qid, interrupt)
	if errors.Is(err, orchestrator.ErrSteerUnsupported) {
		return false, of(KindConflict, usererr.SteerUnsupported())
	}
	return steered, queueErr(err)
}

// CreateSessionInput is the body of POST /sessions.
type CreateSessionInput struct {
	Title       string          `json:"title"`
	Workspace   *WorkspaceInput `json:"workspace"`
	Memory      string          `json:"memory"`
	Model       string          `json:"model"`
	Mode        string          `json:"mode"`
	MakeDefault bool            `json:"make_default"`
	Text        string          `json:"text"`
	FromSession string          `json:"from_session_id"`
	Clear       bool            `json:"clear"`
}

// WorkspaceInput chooses the workspace of a new session: {kind: "shared"}, {kind: "worktree", ...} or {id}.
// Phase 1 has the shared workspace only.
type WorkspaceInput struct {
	Kind         string `json:"kind"`
	ID           string `json:"id"`
	BaseRef      string `json:"base_ref"`
	CarryChanges bool   `json:"carry_changes"`
}

// CreatedSession is the answer of POST /sessions: the session and, with text, the first message or where it
// was queued.
type CreatedSession struct {
	Session    orchestrator.SessionView    `json:"session"`
	Message    *projectstore.Message       `json:"message,omitempty"`
	Queued     *projectstore.QueuedMessage `json:"queued,omitempty"`
	WaitingFor string                      `json:"waiting_for,omitempty"`
}

// CreateSessionWith is POST /sessions (spec section 8): a main session that is not the default unless
// make_default; with from_session_id and clear it is /clear of that session; text sends its first message.
func (s *Service) CreateSessionWith(ctx context.Context, pid string, in CreateSessionInput) (CreatedSession, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return CreatedSession{}, err
	}
	t, err := cleanTitle(in.Title)
	if err != nil {
		return CreatedSession{}, err
	}
	switch in.Memory {
	case "", "project", projectstore.MemoryOn, projectstore.MemoryRead, projectstore.MemoryOff:
	default:
		return CreatedSession{}, invalid("memory must be project, on, read or off")
	}
	if in.Mode != "" {
		if err := validMode(&in.Mode); err != nil {
			return CreatedSession{}, err
		}
	}
	if in.Model != "" {
		if err := s.ValidateModels(&config.Models{Orchestrator: in.Model}); err != nil {
			return CreatedSession{}, err
		}
	}
	var createdWS *projectstore.Workspace
	workspaceID := ""
	if w := in.Workspace; w != nil {
		switch {
		case w.ID != "" && w.ID != projectstore.SharedWorkspace:
			ws, err := db.GetWorkspace(ctx, w.ID)
			if errors.Is(err, projectstore.ErrNotFound) {
				return CreatedSession{}, of(KindNotFound, usererr.WorkspaceNotFound(w.ID))
			}
			if err != nil {
				return CreatedSession{}, storeErr(err)
			}
			workspaceID = ws.ID
		case w.Kind == "worktree":
			folders, err := db.Folders(ctx)
			if err != nil {
				return CreatedSession{}, storeErr(err)
			}
			branch := "octo/" + strings.TrimPrefix(projectstore.NewID("wt"), "wt_")
			if sSlug := slugifyBranchPart(t); sSlug != "" {
				branch = "octo/" + sSlug
			}
			ws, err := s.createWorktreeForProject(ctx, db, folders, branch, w.BaseRef, w.CarryChanges)
			if err != nil {
				return CreatedSession{}, err
			}
			workspaceID = ws.ID
			createdWS = &ws
		case w.Kind != "" && w.Kind != "shared":
			return CreatedSession{}, invalid("workspace.kind must be shared or worktree")
		}
	}
	if in.FromSession != "" && !in.Clear {
		return CreatedSession{}, invalid("from_session_id needs clear: true")
	}
	if in.Clear {
		if _, err := s.mainSessionID(ctx, db, in.FromSession); err != nil {
			return CreatedSession{}, err
		}
	}
	v, err := s.sessions().CreateSession(ctx, pid, orchestrator.NewSessionInput{
		Title: t, Memory: in.Memory, Model: in.Model, Mode: in.Mode, WorkspaceID: workspaceID, MakeDefault: in.MakeDefault, FromSession: in.FromSession, Clear: in.Clear,
	})
	if err != nil {
		return CreatedSession{}, sessionErr(err)
	}
	if createdWS != nil {
		s.hub.Publish(pid, events.WorkspaceUpdated, map[string]any{"workspace": *createdWS})
	}
	out := CreatedSession{Session: v}
	if strings.TrimSpace(in.Text) != "" {
		msg, queued, err := s.PostSessionMessage(ctx, pid, v.ID, in.Text, nil, nil)
		if err != nil {
			return out, err
		}
		if queued != nil {
			out.Queued, out.WaitingFor = queued, queued.WaitingFor
		} else {
			out.Message = &msg
		}
		if info, err := db.SessionInfoOf(ctx, v.ID); err == nil {
			out.Session = s.turns.SessionView(ctx, db, info)
		}
	}
	return out, nil
}

// SetDefaultSession is POST /sessions/{sid}/default (and its alias /resume).
func (s *Service) SetDefaultSession(ctx context.Context, pid, sid string) (orchestrator.SessionView, error) {
	if _, err := s.db(ctx, pid); err != nil {
		return orchestrator.SessionView{}, err
	}
	v, err := s.sessions().SetDefaultSession(ctx, pid, sid)
	return v, sessionErr(err)
}

// SessionPatch is PATCH /sessions/{sid}.
type SessionPatch struct {
	Title    *string `json:"title"`
	Archived *bool   `json:"archived"`
	Memory   *string `json:"memory"`
	Model    *string `json:"model"`
	Mode     *string `json:"mode"`
}

// PatchSessionWith is PATCH /sessions/{sid}: title, archive flag, and for a main session its memory mode, model
// and mode (they apply from its next turn).
func (s *Service) PatchSessionWith(ctx context.Context, pid, sid string, in SessionPatch) (orchestrator.SessionView, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return orchestrator.SessionView{}, err
	}
	if in.Memory == nil && in.Model == nil && in.Mode == nil {
		return s.PatchSession(ctx, pid, sid, in.Title, in.Archived)
	}
	info, err := db.SessionInfoOf(ctx, sid)
	if err != nil {
		return orchestrator.SessionView{}, sessionErr(err)
	}
	if info.Kind != projectstore.KindMain {
		return orchestrator.SessionView{}, invalid("memory, model and mode are settings of a main session")
	}
	if in.Memory != nil && !projectstore.ValidMemoryMode(*in.Memory) {
		return orchestrator.SessionView{}, invalid("memory must be on, read or off")
	}
	if in.Mode != nil && *in.Mode != "" {
		if err := validMode(in.Mode); err != nil {
			return orchestrator.SessionView{}, err
		}
	}
	model := ""
	if in.Model != nil {
		model = strings.TrimSpace(*in.Model)
		if model != "" {
			if err := s.ValidateModels(&config.Models{Orchestrator: model}); err != nil {
				return orchestrator.SessionView{}, err
			}
		}
	}
	if err := db.SetSessionSettings(ctx, sid, model, in.Mode, in.Memory); err != nil {
		return orchestrator.SessionView{}, storeErr(err)
	}
	if in.Title != nil || in.Archived != nil {
		return s.PatchSession(ctx, pid, sid, in.Title, in.Archived)
	}
	if info, err = db.SessionInfoOf(ctx, sid); err != nil {
		return orchestrator.SessionView{}, sessionErr(err)
	}
	v := s.turns.SessionView(ctx, db, info)
	s.hub.Publish(pid, events.SessionUpdated, map[string]any{"session": v})
	return v, nil
}

// ClearSession is POST /sessions/{sid}/clear: /clear of one main session.
func (s *Service) ClearSession(ctx context.Context, pid, sid string) (orchestrator.ClearResult, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return orchestrator.ClearResult{}, err
	}
	if sid, err = s.mainSessionID(ctx, db, sid); err != nil {
		return orchestrator.ClearResult{}, err
	}
	res, err := s.sessions().ClearSession(ctx, pid, sid)
	if errors.Is(err, orchestrator.ErrTurnInProgress) {
		return res, turnInProgress()
	}
	return res, storeErr(err)
}

// CompactSession is POST /sessions/{sid}/compact.
func (s *Service) CompactSession(ctx context.Context, pid, sid string) (orchestrator.CompactResult, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return orchestrator.CompactResult{}, err
	}
	if sid, err = s.mainSessionID(ctx, db, sid); err != nil {
		return orchestrator.CompactResult{}, err
	}
	res, err := s.sessions().CompactSession(ctx, pid, sid)
	return res, compactErr(err)
}

// RewindSession is POST /sessions/{sid}/rewind.
func (s *Service) RewindSession(ctx context.Context, pid, sid string, messageID int64, dryRun bool) (orchestrator.RewindReport, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return orchestrator.RewindReport{}, err
	}
	if sid, err = s.mainSessionID(ctx, db, sid); err != nil {
		return orchestrator.RewindReport{}, err
	}
	rep, err := s.sessions().RewindSession(ctx, pid, sid, messageID, dryRun)
	return rewindErr(rep, err, dryRun)
}

// LatestSessionPlan is GET /sessions/{sid}/plans/latest (projectstore.ErrNotFound: none).
func (s *Service) LatestSessionPlan(ctx context.Context, pid, sid string) (projectstore.Plan, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return projectstore.Plan{}, err
	}
	if sid, err = s.mainSessionID(ctx, db, sid); err != nil {
		return projectstore.Plan{}, err
	}
	return s.sessions().LatestSessionPlan(ctx, pid, sid)
}

// SessionContext is GET /sessions/{sid}/context: the context of the session's root agent.
func (s *Service) SessionContext(ctx context.Context, pid, sid string) (orchestrator.ContextReport, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return orchestrator.ContextReport{}, err
	}
	if sid, err = s.mainSessionID(ctx, db, sid); err != nil {
		return orchestrator.ContextReport{}, err
	}
	root, err := db.RootAgent(ctx, sid)
	if err != nil {
		return orchestrator.ContextReport{}, sessionErr(err)
	}
	return s.Context(ctx, pid, root.ID)
}

// SessionApprovals is GET /approvals?session=: the pending approvals of one main session ("": all).
func (s *Service) SessionApprovals(ctx context.Context, pid, sid string) ([]approval.Approval, error) {
	all, err := s.Approvals(ctx, pid)
	if err != nil || sid == "" {
		return all, err
	}
	return slices.DeleteFunc(all, func(a approval.Approval) bool { return a.SessionID != sid }), nil
}

// SessionInputs is GET /inputs?session=.
func (s *Service) SessionInputs(ctx context.Context, pid, sid string) ([]inputs.Input, error) {
	all, err := s.Inputs(ctx, pid)
	if err != nil || sid == "" {
		return all, err
	}
	return slices.DeleteFunc(all, func(f inputs.Input) bool { return f.SessionID != sid }), nil
}

// SessionChanges is GET /changes?session=: the changes of one main session's turns ("": all).
func (s *Service) SessionChanges(ctx context.Context, pid string, turn int64, sid string) ([]changes.TurnChanges, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return nil, err
	}
	list, err := db.Changes(ctx, turn)
	if err != nil {
		return nil, err
	}
	if sid != "" {
		list = slices.DeleteFunc(list, func(c projectstore.Change) bool { return c.SessionID != sid })
	}
	return changes.Summarize(ctx, db, list)
}

// SessionsSummary is the summary's count of main sessions (spec section 6).
type SessionsSummary struct {
	Total    int `json:"total"`
	Running  int `json:"running"`
	Queued   int `json:"queued"`
	NeedsYou int `json:"needs_you"`
	Failed   int `json:"failed"`
}

// summarizeSessions counts the project's main sessions that are not archived by live state.
func (s *Service) summarizeSessions(ctx context.Context, db *projectstore.DB) SessionsSummary {
	var out SessionsSummary
	list, err := db.ListSessions(ctx, projectstore.SessionFilter{Kind: projectstore.KindMain, Limit: -1})
	if err != nil {
		return out
	}
	for _, i := range list {
		v := s.turns.SessionView(ctx, db, i)
		out.Total++
		switch v.State {
		case projectstore.SessionWorking, projectstore.SessionWaiting:
			out.Running++
		case projectstore.SessionQueued:
			out.Queued++
		case projectstore.SessionFailed:
			out.Failed++
		}
		if v.NeedsYou {
			out.NeedsYou++
		}
	}
	return out
}

// GlobalSession is one row of GET /v1/sessions: a main session with its project.
type GlobalSession struct {
	orchestrator.SessionView
	ProjectID   string `json:"project_id"`
	ProjectName string `json:"project_name"`
}

// AllSessionsQuery is GET /v1/sessions.
type AllSessionsQuery struct {
	Kind, State, Archived, Limit, Before string
}

// AllSessions is GET /v1/sessions: main sessions across projects, newest activity first (last_activity_at),
// limit 1-200 (default 100), before a last_activity_at to page from.
func (s *Service) AllSessions(ctx context.Context, q AllSessionsQuery) ([]GlobalSession, error) {
	if q.Kind != "" && q.Kind != projectstore.KindMain {
		return nil, invalid("kind must be main")
	}
	limit := 100
	if q.Limit != "" {
		n, err := strconv.Atoi(q.Limit)
		if err != nil || n < 1 || n > 200 {
			return nil, invalid("limit must be an integer from 1 to 200")
		}
		limit = n
	}
	ids, err := s.store.IDs(ctx)
	if err != nil {
		return nil, err
	}
	out := []GlobalSession{}
	for _, id := range ids {
		db, err := s.store.Get(ctx, id)
		if err != nil {
			continue
		}
		info, err := db.Info(ctx)
		if err != nil {
			continue
		}
		list, err := s.ListSessions(ctx, id, SessionQuery{Kind: projectstore.KindMain, State: q.State, Archived: q.Archived, Limit: "200"})
		if err != nil {
			return nil, err
		}
		for _, v := range list {
			if q.Before != "" && v.LastActivityAt >= q.Before {
				continue
			}
			out = append(out, GlobalSession{SessionView: v, ProjectID: id, ProjectName: info.Name})
		}
	}
	slices.SortStableFunc(out, func(a, b GlobalSession) int { return strings.Compare(b.LastActivityAt, a.LastActivityAt) })
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}
