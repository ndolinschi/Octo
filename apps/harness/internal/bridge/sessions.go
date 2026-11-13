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

func (s *Server) createSession(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Title string `json:"title"`
	}
	if r.ContentLength != 0 && !decode(w, r, &in) {
		return
	}
	v, err := s.svc.CreateSession(r.Context(), r.PathValue("pid"), in.Title)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"session": v})
}

func (s *Server) resumeSession(w http.ResponseWriter, r *http.Request) {
	v, err := s.svc.ResumeSession(r.Context(), r.PathValue("pid"), r.PathValue("sid"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"session": v})
}

func (s *Server) patchSession(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Title    *string `json:"title"`
		Archived *bool   `json:"archived"`
	}
	if !decode(w, r, &in) {
		return
	}
	v, err := s.svc.PatchSession(r.Context(), r.PathValue("pid"), r.PathValue("sid"), in.Title, in.Archived)
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

func (s *Server) messageSession(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Text           string `json:"text"`
		ReportToParent bool   `json:"report_to_parent"`
	}
	if !decode(w, r, &in) {
		return
	}
	out, v, err := s.svc.MessageSession(r.Context(), r.PathValue("pid"), r.PathValue("sid"), in.Text, in.ReportToParent)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"outcome": out, "session": v})
}
