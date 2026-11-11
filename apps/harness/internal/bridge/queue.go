package bridge

import "net/http"

func (s *Server) getQueue(w http.ResponseWriter, r *http.Request) {
	q, err := s.svc.Queue(r.Context(), r.PathValue("pid"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, q)
}

func (s *Server) editQueued(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Text string `json:"text"`
	}
	if !decode(w, r, &in) {
		return
	}
	m, err := s.svc.EditQueued(r.Context(), r.PathValue("pid"), r.PathValue("qid"), in.Text)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, m)
}

func (s *Server) removeQueued(w http.ResponseWriter, r *http.Request) {
	if err := s.svc.RemoveQueued(r.Context(), r.PathValue("pid"), r.PathValue("qid")); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) clearQueue(w http.ResponseWriter, r *http.Request) {
	if err := s.svc.RemoveQueued(r.Context(), r.PathValue("pid"), ""); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) resumeQueue(w http.ResponseWriter, r *http.Request) {
	if err := s.svc.ResumeQueue(r.Context(), r.PathValue("pid")); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{})
}

func (s *Server) sendNow(w http.ResponseWriter, r *http.Request) {
	if err := s.svc.SendNow(r.Context(), r.PathValue("pid"), r.PathValue("qid")); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{})
}
