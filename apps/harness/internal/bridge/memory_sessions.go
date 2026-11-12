package bridge

import "net/http"

func (s *Server) listMemorySessions(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	l, err := s.svc.MemorySessions(r.Context(), r.PathValue("pid"), q.Get("limit"), q.Get("before"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": l})
}

func (s *Server) getMemorySession(w http.ResponseWriter, r *http.Request) {
	d, err := s.svc.MemorySession(r.Context(), r.PathValue("pid"), r.PathValue("sid"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, d)
}

func (s *Server) forgetExchange(w http.ResponseWriter, r *http.Request) {
	if err := s.svc.ForgetExchange(r.Context(), r.PathValue("pid"), r.PathValue("eid")); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
