package bridge

import (
	"net/http"

	"github.com/ndolinschi/Octo/apps/harness/internal/limits"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
)

// LimitSource is the rate-limit view GET /v1/limits serves.
type LimitSource interface {
	Snapshot() []limits.Limit
}

// WithLimits serves the observed rate limits at GET /v1/limits (empty otherwise).
func WithLimits(src LimitSource) Option { return func(s *Server) { s.limits = src } }

func (s *Server) usage(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	rep, err := s.svc.Usage(r.Context(), project.UsageQuery{
		From: q.Get("from"), To: q.Get("to"), Group: q.Get("group"), ProjectID: q.Get("project"),
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rep)
}

func (s *Server) listLimits(w http.ResponseWriter, r *http.Request) {
	list := []limits.Limit{}
	if s.limits != nil {
		list = append(list, s.limits.Snapshot()...)
	}
	writeJSON(w, http.StatusOK, map[string]any{"limits": list})
}
