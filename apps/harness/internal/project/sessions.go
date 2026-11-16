package project

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/sessionimport"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// maxSessionMessage bounds a message to an agent session (characters).
const maxSessionMessage = 100_000

// SessionQuery is GET /sessions.
type SessionQuery struct {
	Kind, State, Archived, Limit, Before string
}

// SessionDetail is GET /sessions/{sid}: the session, its exchanges (a main session's requests and answers),
// the agent sessions it started and, for an agent session, the agent row (task, result, usage).
type SessionDetail struct {
	Session   orchestrator.SessionView   `json:"session"`
	Exchanges []projectstore.Exchange    `json:"exchanges"`
	Children  []orchestrator.SessionView `json:"children"`
	Agent     *projectstore.Agent        `json:"agent,omitempty"`
}

// SessionMessages is GET /sessions/{sid}/messages: the transcript of one session in the shape of an agent's
// messages route (markers included), for a main session only what was stored in it.
type SessionMessages struct {
	Messages      []projectstore.Message `json:"messages"`
	Compactions   []Compaction           `json:"compactions"`
	Conversations []Conversation         `json:"conversations"`
}

func sessionErr(err error) error {
	var se *orchestrator.SessionError
	switch {
	case err == nil:
		return nil
	case errors.Is(err, orchestrator.ErrTurnInProgress):
		return turnInProgress()
	case errors.Is(err, projectstore.ErrNotFound):
		return notFound("session")
	case errors.Is(err, projectstore.ErrSessionCurrent):
		return of(KindConflict, usererr.SessionRefused("current_session", "", err.Error()))
	case errors.As(err, &se):
		if se.User != nil {
			return of(KindConflict, se.User)
		}
		return of(KindConflict, usererr.SessionRefused(se.Code, "", se.Message))
	case orchestrator.IsNoBuiltinLoop(err):
		return of(KindConflict, usererr.SessionRefused("builtin_loop_unavailable", "", err.Error()))
	}
	return storeErr(err)
}

// ListSessions is GET /sessions.
func (s *Service) ListSessions(ctx context.Context, pid string, q SessionQuery) ([]orchestrator.SessionView, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return nil, err
	}
	f := projectstore.SessionFilter{Before: q.Before}
	switch q.Kind {
	case "", projectstore.KindMain, projectstore.KindAgent:
		f.Kind = q.Kind
	default:
		return nil, invalid("kind must be main or agent")
	}
	switch q.State {
	case "", projectstore.SessionWorking, projectstore.SessionWaiting, projectstore.SessionQueued, projectstore.SessionIdle, projectstore.SessionFailed, projectstore.SessionStopped:
	default:
		return nil, invalid("state must be working, waiting, queued, idle, failed or stopped")
	}
	switch q.Archived {
	case "", "false":
	case "true", "all":
		f.Archived = q.Archived
	default:
		return nil, invalid("archived must be true, false or all")
	}
	limit := 50
	if q.Limit != "" {
		if limit, err = strconv.Atoi(q.Limit); err != nil || limit < 1 || limit > 200 {
			return nil, invalid("limit must be an integer from 1 to 200")
		}
	}
	// The live state (working, waiting) is not stored, so a state filter is applied after it is known.
	f.Limit = limit
	if q.State != "" {
		f.Limit = -1
	}
	if _, err := db.CurrentSessionID(ctx); err != nil {
		return nil, storeErr(err)
	}
	list, err := db.ListSessions(ctx, f)
	if err != nil {
		return nil, storeErr(err)
	}
	out := make([]orchestrator.SessionView, 0, len(list))
	for _, i := range list {
		v := s.turns.SessionView(ctx, db, i)
		if q.State != "" && v.State != q.State {
			continue
		}
		if out = append(out, v); len(out) == limit {
			break
		}
	}
	return out, nil
}

// GetSession is GET /sessions/{sid}.
func (s *Service) GetSession(ctx context.Context, pid, sid string) (SessionDetail, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return SessionDetail{}, err
	}
	info, err := db.SessionInfoOf(ctx, sid)
	if err != nil {
		return SessionDetail{}, sessionErr(err)
	}
	d := SessionDetail{Session: s.turns.SessionView(ctx, db, info), Exchanges: []projectstore.Exchange{}, Children: []orchestrator.SessionView{}}
	if info.Kind == projectstore.KindMain {
		if _, ex, err := db.SessionOf(ctx, sid); err == nil {
			d.Exchanges = ex
		} else {
			return d, storeErr(err)
		}
		kids, err := db.ChildSessions(ctx, sid)
		if err != nil {
			return d, storeErr(err)
		}
		for _, k := range kids {
			d.Children = append(d.Children, s.turns.SessionView(ctx, db, k))
		}
		return d, nil
	}
	a, err := db.Agent(ctx, info.AgentID)
	if err != nil {
		return d, sessionErr(err)
	}
	d.Agent = &a
	return d, nil
}

// SessionMessagesOf is GET /sessions/{sid}/messages.
func (s *Service) SessionMessagesOf(ctx context.Context, pid, sid string) (SessionMessages, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return SessionMessages{}, err
	}
	info, err := db.SessionInfoOf(ctx, sid)
	if err != nil {
		return SessionMessages{}, sessionErr(err)
	}
	msgs, err := db.SessionMessages(ctx, sid)
	if err != nil {
		return SessionMessages{}, storeErr(err)
	}
	out := SessionMessages{Messages: msgs, Compactions: []Compaction{}, Conversations: []Conversation{}}
	if info.Kind != projectstore.KindMain {
		return out, nil
	}
	if info.RootAgentID == "" {
		return out, nil
	}
	return s.filterMarkers(ctx, db, info.RootAgentID, sid, out)
}

// MessagesOfSession is the agent's messages route restricted to one main session (?session_id=): its messages
// and the markers that belong to it.
func (s *Service) MessagesOfSession(ctx context.Context, pid, aid, sid string) (SessionMessages, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return SessionMessages{}, err
	}
	info, err := db.SessionInfoOf(ctx, sid)
	if err != nil || info.Kind != projectstore.KindMain {
		return SessionMessages{}, notFound("session")
	}
	// Schema 15: a session's messages are on its own root agent; any root's route answers for it.
	if a, err := db.Agent(ctx, aid); err == nil && a.ParentID == nil && info.RootAgentID != "" {
		aid = info.RootAgentID
	}
	all, err := db.Messages(ctx, aid)
	if err != nil {
		return SessionMessages{}, storeErr(err)
	}
	out := SessionMessages{Messages: []projectstore.Message{}, Compactions: []Compaction{}, Conversations: []Conversation{}}
	for _, m := range all {
		if m.SessionID == sid {
			out.Messages = append(out.Messages, m)
		}
	}
	return s.filterMarkers(ctx, db, aid, sid, out)
}

// filterMarkers adds the compaction markers inside a session's messages and the clear that started it.
func (s *Service) filterMarkers(ctx context.Context, db *projectstore.DB, aid, sid string, out SessionMessages) (SessionMessages, error) {
	have := map[int64]bool{}
	for _, m := range out.Messages {
		have[m.ID] = true
	}
	comps, err := db.Compactions(ctx, aid)
	if err != nil {
		return out, storeErr(err)
	}
	for _, c := range comps {
		if have[c.UptoMessageID] {
			out.Compactions = append(out.Compactions, Compaction{UptoMessageID: c.UptoMessageID, At: c.CreatedAt, SummaryTokens: c.SummaryTokens(),
				Label: "history compacted", Manual: c.Manual, MessageCount: c.MessageCount})
		}
	}
	clears, err := db.Clears(ctx, aid)
	if err != nil {
		return out, storeErr(err)
	}
	for _, c := range clears {
		if c.SessionID == sid {
			out.Conversations = append(out.Conversations, Conversation{ConversationID: c.ConversationID, UptoMessageID: c.UptoMessageID, At: c.CreatedAt,
				Label: clearLabel(c.Title), Title: c.Title, Summary: c.Summary, SummarySource: c.SummarySource})
		}
	}
	return out, nil
}

// CreateSession is POST /sessions: a new main session, made current (the same effect as /clear).
func (s *Service) CreateSession(ctx context.Context, pid, title string) (orchestrator.SessionView, error) {
	if _, err := s.db(ctx, pid); err != nil {
		return orchestrator.SessionView{}, err
	}
	if t, err := cleanTitle(title); err != nil {
		return orchestrator.SessionView{}, err
	} else {
		title = t
	}
	v, err := s.turns.NewSession(ctx, pid, title)
	return v, sessionErr(err)
}

// ResumeSession is POST /sessions/{sid}/resume.
func (s *Service) ResumeSession(ctx context.Context, pid, sid string) (orchestrator.SessionView, error) {
	if _, err := s.db(ctx, pid); err != nil {
		return orchestrator.SessionView{}, err
	}
	v, err := s.turns.ResumeSession(ctx, pid, sid)
	return v, sessionErr(err)
}

func cleanTitle(t string) (string, error) {
	t = strings.Join(strings.Fields(t), " ")
	if len([]rune(t)) > 200 {
		return "", invalid("title is at most 200 characters")
	}
	return t, nil
}

// PatchSession is PATCH /sessions/{sid}: the title and the archive flag.
func (s *Service) PatchSession(ctx context.Context, pid, sid string, title *string, archived *bool) (orchestrator.SessionView, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return orchestrator.SessionView{}, err
	}
	if title == nil && archived == nil {
		return orchestrator.SessionView{}, invalid("send title and/or archived")
	}
	if title != nil {
		t, err := cleanTitle(*title)
		if err != nil {
			return orchestrator.SessionView{}, err
		}
		if t == "" {
			return orchestrator.SessionView{}, invalid("title must not be empty")
		}
		title = &t
	}
	info, err := db.PatchSession(ctx, sid, title, archived)
	if err != nil {
		return orchestrator.SessionView{}, sessionErr(err)
	}
	v := s.turns.SessionView(ctx, db, info)
	s.hub.Publish(pid, events.SessionUpdated, map[string]any{"session": v})
	return v, nil
}

// DeleteSession is DELETE /sessions/{sid}: not the current main session, not one that is running.
func (s *Service) DeleteSession(ctx context.Context, pid, sid string) error {
	db, err := s.db(ctx, pid)
	if err != nil {
		return err
	}
	info, err := db.SessionInfoOf(ctx, sid)
	if err != nil {
		return sessionErr(err)
	}
	busy := info.State == projectstore.SessionWorking
	if info.Kind == projectstore.KindMain {
		busy = busy || s.sessions().ActiveSession(pid, sid)
		kids, _ := db.ChildSessions(ctx, sid)
		for _, k := range kids {
			busy = busy || k.State == projectstore.SessionWorking
		}
	}
	if busy {
		return of(KindConflict, usererr.SessionRefused("session_running", "", "this session (or one it started) is running"))
	}
	removed, err := db.DeleteSession(ctx, sid)
	if err != nil {
		return sessionErr(err)
	}
	for _, id := range removed {
		s.hub.Publish(pid, events.SessionUpdated, map[string]any{"session_id": id, "deleted": true})
	}
	if info.Kind == projectstore.KindMain {
		s.sessions().ForgetSession(pid, sid)
		s.hub.Publish(pid, "memory.updated", map[string]any{"session_id": sid, "deleted": true})
	}
	return nil
}

// StopSession is POST /sessions/{sid}/stop.
func (s *Service) StopSession(ctx context.Context, pid, sid string) (orchestrator.SessionView, error) {
	if _, err := s.db(ctx, pid); err != nil {
		return orchestrator.SessionView{}, err
	}
	v, err := s.turns.StopSession(ctx, pid, sid)
	return v, sessionErr(err)
}

// MessageSession is POST /sessions/{sid}/messages: a message to an agent session.
func (s *Service) MessageSession(ctx context.Context, pid, sid, text string, report bool) (orchestrator.MessageOutcome, orchestrator.SessionView, error) {
	if _, err := s.db(ctx, pid); err != nil {
		return "", orchestrator.SessionView{}, err
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return "", orchestrator.SessionView{}, invalid("text must not be empty")
	}
	if len([]rune(text)) > maxSessionMessage {
		return "", orchestrator.SessionView{}, invalid("text is too long")
	}
	out, v, err := s.turns.MessageAgentSession(ctx, pid, sid, text, report)
	return out, v, sessionErr(err)
}

func (s *Service) projectHasRunningSession(ctx context.Context, pid string, db *projectstore.DB) bool {
	if s.turns.Active(pid) || s.turns.Running(pid) {
		return true
	}
	list, err := db.ListSessions(ctx, projectstore.SessionFilter{Archived: "all", Limit: -1})
	if err != nil {
		return false
	}
	st, hasST := s.turns.(SessionTurns)
	for _, info := range list {
		if info.State == projectstore.SessionWorking || info.State == projectstore.SessionWaiting {
			return true
		}
		if info.Kind == projectstore.KindMain && hasST && st.ActiveSession(pid, info.ID) {
			return true
		}
	}
	return false
}

func (s *Service) clearProjectSessionsLocked(ctx context.Context, pid string, db *projectstore.DB) (deleted int, defaultSID string, err error) {
	deleted, removedIDs, def, err := db.DeleteAllSessions(ctx)
	if err != nil {
		return 0, "", storeErr(err)
	}
	if st, ok := s.turns.(SessionTurns); ok {
		for _, id := range removedIDs {
			st.ForgetSession(pid, id)
		}
	}
	s.turns.CloseProject(pid)
	for _, id := range removedIDs {
		s.hub.Publish(pid, events.SessionUpdated, map[string]any{"session_id": id, "deleted": true})
	}
	s.hub.Publish(pid, events.SessionCreated, map[string]any{"session": s.turns.SessionView(ctx, db, def)})
	s.hub.Publish(pid, events.SessionDefault, map[string]any{"session_id": def.ID})
	s.hub.Publish(pid, events.SessionCurrent, map[string]any{"session_id": def.ID})
	s.hub.Publish(pid, "memory.updated", map[string]any{"deleted": true})
	s.announceProject(pid)
	return deleted, def.ID, nil
}

// DeleteAllSessions is DELETE /v1/projects/{pid}/sessions: clears every session of pid and resets it to one fresh idle default session.
func (s *Service) DeleteAllSessions(ctx context.Context, pid string) (deleted int, defaultSID string, err error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return 0, "", err
	}
	if s.projectHasRunningSession(ctx, pid, db) {
		return 0, "", of(KindConflict, usererr.SessionRefused("session_running", "", "a session in this project is still running"))
	}
	return s.clearProjectSessionsLocked(ctx, pid, db)
}

// DeleteEveryProjectSessions is DELETE /v1/sessions: clears every session in every project when none are running.
func (s *Service) DeleteEveryProjectSessions(ctx context.Context) (deleted int, projects int, err error) {
	ids, err := s.store.IDs(ctx)
	if err != nil {
		return 0, 0, storeErr(err)
	}
	dbs := make([]*projectstore.DB, 0, len(ids))
	for _, pid := range ids {
		db, err := s.store.Get(ctx, pid)
		if err != nil {
			continue
		}
		if s.projectHasRunningSession(ctx, pid, db) {
			return 0, 0, of(KindConflict, usererr.SessionRefused("session_running", "", "a session is still running in project "+pid))
		}
		dbs = append(dbs, db)
	}
	for _, db := range dbs {
		n, _, err := s.clearProjectSessionsLocked(ctx, db.ID(), db)
		if err != nil {
			return deleted, projects, err
		}
		deleted += n
		projects++
	}
	return deleted, projects, nil
}

// ImportableSession is an external CLI session enriched with Octo project matching and duplicate status.
type ImportableSession struct {
	sessionimport.Candidate
	AlreadyImported    bool   `json:"already_imported"`
	MatchedProjectID   string `json:"matched_project_id,omitempty"`
	MatchedProjectName string `json:"matched_project_name,omitempty"`
}

// ListImportableSessions is GET /v1/sessions/importable.
func (s *Service) ListImportableSessions(ctx context.Context) ([]ImportableSession, error) {
	candidates, err := sessionimport.NewScanner(sessionimport.DefaultHomeDir()).Scan(ctx)
	if err != nil {
		return nil, storeErr(err)
	}
	ids, err := s.store.IDs(ctx)
	if err != nil {
		return nil, storeErr(err)
	}
	type projFolder struct {
		pid, name, path string
	}
	var folders []projFolder
	imported := map[string]bool{}
	for _, pid := range ids {
		db, err := s.store.Get(ctx, pid)
		if err != nil {
			continue
		}
		info, err := db.Info(ctx)
		if err != nil {
			continue
		}
		if srcs, err := db.ImportedSources(ctx); err == nil {
			for k := range srcs {
				imported[k] = true
			}
		}
		flist, err := db.Folders(ctx)
		if err != nil {
			continue
		}
		for _, f := range flist {
			if p := strings.TrimSpace(f.Path); p != "" {
				folders = append(folders, projFolder{pid: pid, name: info.Name, path: filepath.Clean(p)})
			}
		}
	}

	out := make([]ImportableSession, 0, len(candidates))
	for _, c := range candidates {
		item := ImportableSession{
			Candidate:       c,
			AlreadyImported: imported[c.Provider+":"+c.ID],
		}
		if cwd := strings.TrimSpace(c.Cwd); cwd != "" {
			cleanCwd := filepath.Clean(cwd)
			bestLen := -1
			for _, f := range folders {
				if cleanCwd == f.path || strings.HasPrefix(cleanCwd, f.path+string(os.PathSeparator)) {
					if len(f.path) > bestLen {
						bestLen = len(f.path)
						item.MatchedProjectID = f.pid
						item.MatchedProjectName = f.name
					}
				}
			}
		}
		out = append(out, item)
	}
	return out, nil
}

// ImportSessionRef selects one discovered external session to import.
type ImportSessionRef struct {
	Provider string `json:"provider"`
	ID       string `json:"id"`
}

// ImportSessionsResult is the response of POST /v1/projects/{pid}/sessions/import.
type ImportSessionsResult struct {
	Imported []orchestrator.SessionView `json:"imported"`
	Skipped  int                        `json:"skipped"`
}

// ImportSessions imports selected external CLI transcripts into pid.
func (s *Service) ImportSessions(ctx context.Context, pid string, refs []ImportSessionRef) (ImportSessionsResult, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return ImportSessionsResult{}, err
	}
	if len(refs) == 0 {
		return ImportSessionsResult{}, invalid("sessions is required")
	}
	scanner := sessionimport.NewScanner(sessionimport.DefaultHomeDir())
	out := ImportSessionsResult{Imported: []orchestrator.SessionView{}}
	seen := map[string]bool{}
	for _, ref := range refs {
		prov := strings.TrimSpace(ref.Provider)
		id := strings.TrimSpace(ref.ID)
		if prov == "" || id == "" {
			return out, invalid("each session requires provider and id")
		}
		key := prov + ":" + id
		if seen[key] {
			continue
		}
		seen[key] = true
		cand, ok := scanner.Load(ctx, prov, id)
		if !ok {
			return out, notFound("importable session " + key)
		}
		turns := make([]projectstore.ImportTurn, 0, len(cand.Turns))
		for _, t := range cand.Turns {
			turns = append(turns, projectstore.ImportTurn{
				Role: t.Role, Text: t.Text, Timestamp: t.Timestamp, Model: t.Model,
			})
		}
		info, created, err := db.ImportMainSession(ctx, projectstore.ImportSessionInput{
			Provider:   cand.Provider,
			ExternalID: cand.ID,
			Title:      cand.Title,
			Model:      cand.Model,
			StartedAt:  cand.StartedAt,
			EndedAt:    cand.UpdatedAt,
			Turns:      turns,
		})
		if err != nil {
			return out, storeErr(err)
		}
		if !created {
			out.Skipped++
			continue
		}
		v := s.turns.SessionView(ctx, db, info)
		out.Imported = append(out.Imported, v)
		s.hub.Publish(pid, events.SessionCreated, map[string]any{"session": v})
		s.hub.Publish(pid, "memory.updated", map[string]any{"session_id": v.ID, "imported": true})
	}
	if len(out.Imported) > 0 {
		s.announceProject(pid)
	}
	return out, nil
}
