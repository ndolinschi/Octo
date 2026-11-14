package bridge

import "net/http"

func (s *Server) getQueue(w http.ResponseWriter, r *http.Request) {
	q, err := s.svc.SessionQueueState(r.Context(), r.PathValue("pid"), r.PathValue("sid"))
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
	m, err := s.svc.EditSessionQueued(r.Context(), r.PathValue("pid"), r.PathValue("sid"), r.PathValue("qid"), in.Text)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, m)
}

func (s *Server) removeQueued(w http.ResponseWriter, r *http.Request) {
	if err := s.svc.RemoveSessionQueued(r.Context(), r.PathValue("pid"), r.PathValue("sid"), r.PathValue("qid")); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) clearQueue(w http.ResponseWriter, r *http.Request) {
	if err := s.svc.RemoveSessionQueued(r.Context(), r.PathValue("pid"), r.PathValue("sid"), ""); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) resumeQueue(w http.ResponseWriter, r *http.Request) {
	if err := s.svc.ResumeSessionQueue(r.Context(), r.PathValue("pid"), r.PathValue("sid")); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{})
}

func (s *Server) sendNow(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Interrupt bool `json:"interrupt"`
	}
	if r.Body != nil && r.ContentLength != 0 {
		if !decode(w, r, &in) {
			return
		}
	}
	steered, err := s.svc.SendNowSession(r.Context(), r.PathValue("pid"), r.PathValue("sid"), r.PathValue("qid"), in.Interrupt)
	if err != nil {
		writeErr(w, err)
		return
	}
	if steered {
		writeJSON(w, http.StatusAccepted, map[string]any{"steered": true})
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{})
}
