package bridge

import (
	"net/http"
	"strconv"

	"github.com/ndolinschi/Octo/apps/harness/internal/project"
)

func (s *Server) listChanges(w http.ResponseWriter, r *http.Request) {
	var turn int64
	if v := r.URL.Query().Get("turn"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 1 {
			writeError(w, http.StatusBadRequest, "invalid_request", "turn must be a positive integer")
			return
		}
		turn = n
	}
	turns, err := s.svc.SessionChanges(r.Context(), r.PathValue("pid"), turn, r.URL.Query().Get("session"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"turns": turns})
}

// changeID parses {cid}; false after answering 404 (an id that is no number names nothing).
func changeID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("cid"), 10, 64)
	if err != nil || id < 1 {
		writeError(w, http.StatusNotFound, "not_found", "change not found")
		return 0, false
	}
	return id, true
}

func (s *Server) getChange(w http.ResponseWriter, r *http.Request) {
	id, ok := changeID(w, r)
	if !ok {
		return
	}
	d, err := s.svc.Change(r.Context(), r.PathValue("pid"), id)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, d)
}

func (s *Server) revertChange(w http.ResponseWriter, r *http.Request) {
	id, ok := changeID(w, r)
	if !ok {
		return
	}
	res, err := s.svc.RevertChange(r.Context(), r.PathValue("pid"), id)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) listApprovals(w http.ResponseWriter, r *http.Request) {
	list, err := s.svc.SessionApprovals(r.Context(), r.PathValue("pid"), r.URL.Query().Get("session"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"approvals": list})
}

func (s *Server) resolveApproval(w http.ResponseWriter, r *http.Request) {
	var in project.ApprovalAnswer
	if !decode(w, r, &in) {
		return
	}
	if err := s.svc.ResolveApproval(r.Context(), r.PathValue("pid"), r.PathValue("id"), in); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) listApprovalRules(w http.ResponseWriter, r *http.Request) {
	rules, err := s.svc.ApprovalRules(r.Context(), r.PathValue("pid"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"rules": rules})
}

func (s *Server) deleteApprovalRule(w http.ResponseWriter, r *http.Request) {
	if err := s.svc.DeleteApprovalRule(r.Context(), r.PathValue("pid"), r.PathValue("rid")); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
