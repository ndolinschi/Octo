package bridge

import (
	"net/http"
	"strconv"

	"github.com/ndolinschi/Octo/apps/harness/internal/project"
)

func (s *Server) listTasks(w http.ResponseWriter, r *http.Request) {
	t, err := s.svc.Tasks(r.Context(), r.PathValue("pid"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tasks": t})
}

func (s *Server) listMemory(w http.ResponseWriter, r *http.Request) {
	l, err := s.svc.MemoryFiles(r.Context(), r.PathValue("pid"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, l)
}

func (s *Server) searchMemory(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	res, err := s.svc.SearchMemory(r.Context(), r.PathValue("pid"), project.SearchMemoryQuery{
		Q: q.Get("q"), In: q.Get("in"), After: q.Get("after"), Before: q.Get("before"), Limit: q.Get("limit"),
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) getMemoryFile(w http.ResponseWriter, r *http.Request) {
	f, err := s.svc.MemoryFile(r.Context(), r.PathValue("pid"), r.PathValue("name"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, f)
}

func (s *Server) putMemoryFile(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Content string `json:"content"`
		Summary string `json:"summary"`
	}
	if !decode(w, r, &in) {
		return
	}
	f, err := s.svc.PutMemoryFile(r.Context(), r.PathValue("pid"), r.PathValue("name"), in.Content, in.Summary)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, f)
}

func (s *Server) deleteMemoryFile(w http.ResponseWriter, r *http.Request) {
	if err := s.svc.DeleteMemoryFile(r.Context(), r.PathValue("pid"), r.PathValue("name")); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) turnContext(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("tid"), 10, 64)
	if err != nil || id < 1 {
		writeError(w, http.StatusNotFound, "not_found", "context receipt not found")
		return
	}
	raw, err := s.svc.TurnContext(r.Context(), r.PathValue("pid"), id)
	if err != nil {
		writeErr(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(raw)
}
