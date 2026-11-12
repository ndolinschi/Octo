package bridge

import "net/http"

func (s *Server) rememberFact(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Text  string `json:"text"`
		Kind  string `json:"kind"`
		About string `json:"about"`
	}
	if !decode(w, r, &in) {
		return
	}
	res, err := s.svc.Remember(r.Context(), r.PathValue("pid"), in.Text, in.Kind, in.About)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, res)
}

func (s *Server) forgetFact(w http.ResponseWriter, r *http.Request) {
	if err := s.svc.Forget(r.Context(), r.PathValue("pid"), r.PathValue("tid"), r.PathValue("fid")); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
