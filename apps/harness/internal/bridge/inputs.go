package bridge

import (
	"net/http"

	"github.com/ndolinschi/Octo/apps/harness/internal/inputs"
)

func (s *Server) listInputs(w http.ResponseWriter, r *http.Request) {
	list, err := s.svc.Inputs(r.Context(), r.PathValue("pid"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"inputs": list})
}

func (s *Server) submitInput(w http.ResponseWriter, r *http.Request) {
	var in inputs.Answer
	if !decode(w, r, &in) {
		return
	}
	if err := s.svc.SubmitInput(r.Context(), r.PathValue("pid"), r.PathValue("id"), in); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) listSecrets(w http.ResponseWriter, r *http.Request) {
	list, err := s.svc.Secrets(r.Context(), r.PathValue("pid"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"secrets": list})
}

func (s *Server) putSecret(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Value string `json:"value"`
	}
	if !decode(w, r, &in) {
		return
	}
	if err := s.svc.PutSecret(r.Context(), r.PathValue("pid"), r.PathValue("name"), in.Value); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) deleteSecret(w http.ResponseWriter, r *http.Request) {
	if err := s.svc.DeleteSecret(r.Context(), r.PathValue("pid"), r.PathValue("name")); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
