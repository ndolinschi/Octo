package bridge

import (
	"net/http"
	"strconv"

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

// listBranches is GET /branches?folder=&workspace=&q=&offset=&limit= (UI decision 98).
func (s *Server) listBranches(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	in := project.BranchesQuery{Folder: q.Get("folder"), Workspace: q.Get("workspace"), Query: q.Get("q")}
	for name, dst := range map[string]*int{"offset": &in.Offset, "limit": &in.Limit} {
		if v := q.Get(name); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil {
				n = -1 // refused by the service with the catalogue's wording
			}
			*dst = n
		}
	}
	res, err := s.svc.Branches(r.Context(), r.PathValue("pid"), in)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// switchBranch is POST /branches/switch {folder?, branch, create?}.
func (s *Server) switchBranch(w http.ResponseWriter, r *http.Request) {
	var in project.SwitchBranchInput
	if !decode(w, r, &in) {
		return
	}
	res, err := s.svc.SwitchBranch(r.Context(), r.PathValue("pid"), in)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}
