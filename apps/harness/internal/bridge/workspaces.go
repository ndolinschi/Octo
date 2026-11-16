package bridge

import (
	"net/http"

	"github.com/ndolinschi/Octo/apps/harness/internal/project"
)

func (s *Server) listWorkspaces(w http.ResponseWriter, r *http.Request) {
	list, err := s.svc.ListWorkspaces(r.Context(), r.PathValue("pid"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"workspaces": list})
}

func (s *Server) moveSessionToWorktree(w http.ResponseWriter, r *http.Request) {
	var in project.MoveWorktreeInput
	if r.ContentLength != 0 && !decode(w, r, &in) {
		return
	}
	res, err := s.svc.MoveSessionToWorktree(r.Context(), r.PathValue("pid"), r.PathValue("sid"), in)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}
