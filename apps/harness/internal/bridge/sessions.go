package bridge

import (
	"net/http"

	"github.com/ndolinschi/Octo/apps/harness/internal/project"
)

func (s *Server) listSessions(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	l, err := s.svc.ListSessions(r.Context(), r.PathValue("pid"), project.SessionQuery{
		Kind: q.Get("kind"), State: q.Get("state"), Archived: q.Get("archived"), Limit: q.Get("limit"), Before: q.Get("before"),
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": l})
}

func (s *Server) getSession(w http.ResponseWriter, r *http.Request) {
	d, err := s.svc.GetSession(r.Context(), r.PathValue("pid"), r.PathValue("sid"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, d)
}

func (s *Server) sessionMessages(w http.ResponseWriter, r *http.Request) {
	d, err := s.svc.SessionMessagesOf(r.Context(), r.PathValue("pid"), r.PathValue("sid"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, d)
}

// createSession is POST /sessions: a main session (not the default unless make_default; with from_session_id
// and clear it is /clear of that session; text sends its first message). 201 {session, message?, queued?}.
func (s *Server) createSession(w http.ResponseWriter, r *http.Request) {
	var in project.CreateSessionInput
	if r.ContentLength != 0 && !decode(w, r, &in) {
		return
	}
	out, err := s.svc.CreateSessionWith(r.Context(), r.PathValue("pid"), in)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

// resumeSession is POST /sessions/{sid}/default (and its alias /resume): the session becomes the default.
func (s *Server) resumeSession(w http.ResponseWriter, r *http.Request) {
	v, err := s.svc.SetDefaultSession(r.Context(), r.PathValue("pid"), r.PathValue("sid"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"session": v})
}

func (s *Server) patchSession(w http.ResponseWriter, r *http.Request) {
	var in project.SessionPatch
	if !decode(w, r, &in) {
		return
	}
	v, err := s.svc.PatchSessionWith(r.Context(), r.PathValue("pid"), r.PathValue("sid"), in)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"session": v})
}

func (s *Server) deleteSession(w http.ResponseWriter, r *http.Request) {
	if err := s.svc.DeleteSession(r.Context(), r.PathValue("pid"), r.PathValue("sid")); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) stopSession(w http.ResponseWriter, r *http.Request) {
	v, err := s.svc.StopSession(r.Context(), r.PathValue("pid"), r.PathValue("sid"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"session": v})
}

// messageSession is POST /sessions/{sid}/messages: a main session takes it like POST /messages (202 {message} or
// {queued, waiting_for}); an agent session is steered or continued (202 {outcome, session}).
func (s *Server) messageSession(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Text           string   `json:"text"`
		ReportToParent bool     `json:"report_to_parent"`
		Mode           *string  `json:"mode"`
		Attachments    []string `json:"attachments"`
	}
	if !decode(w, r, &in) {
		return
	}
	if main, err := s.svc.IsMainSession(r.Context(), r.PathValue("pid"), r.PathValue("sid")); err != nil {
		writeErr(w, err)
		return
	} else if main {
		s.postSessionMessage(w, r, in.Text, in.Mode, in.Attachments)
		return
	}
	out, v, err := s.svc.MessageSession(r.Context(), r.PathValue("pid"), r.PathValue("sid"), in.Text, in.ReportToParent)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"outcome": out, "session": v})
}

// listAllSessions is GET /v1/sessions: main sessions across projects, newest activity first.
func (s *Server) listAllSessions(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	l, err := s.svc.AllSessions(r.Context(), project.AllSessionsQuery{
		Kind: q.Get("kind"), State: q.Get("state"), Archived: q.Get("archived"), Limit: q.Get("limit"), Before: q.Get("before"),
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": l})
}
