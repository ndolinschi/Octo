package bridge

import "net/http"

func (s *Server) askSide(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Text string `json:"text"`
	}
	if !decode(w, r, &in) {
		return
	}
	start, err := s.svc.AskSide(r.Context(), r.PathValue("pid"), in.Text)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"side_id": start.SideID, "message": start.Message})
}

func (s *Server) stopSide(w http.ResponseWriter, r *http.Request) {
	if err := s.svc.StopSide(r.Context(), r.PathValue("pid")); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) listSide(w http.ResponseWriter, r *http.Request) {
	msgs, err := s.svc.SideMessages(r.Context(), r.PathValue("pid"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"messages": msgs})
}

func (s *Server) clearSide(w http.ResponseWriter, r *http.Request) {
	if err := s.svc.ClearSide(r.Context(), r.PathValue("pid")); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
