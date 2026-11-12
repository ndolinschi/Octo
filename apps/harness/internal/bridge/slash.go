package bridge

import "net/http"

func (s *Server) slashCommands(w http.ResponseWriter, r *http.Request) {
	rep, err := s.svc.SlashCommands(r.Context(), r.PathValue("pid"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rep)
}

func (s *Server) clearConversation(w http.ResponseWriter, r *http.Request) {
	res, err := s.svc.Clear(r.Context(), r.PathValue("pid"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}
