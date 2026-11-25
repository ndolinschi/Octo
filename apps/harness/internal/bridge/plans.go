package bridge

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// latestPlan answers GET /v1/projects/{pid}/plans/latest: 200 {"plan": {...}}, or 200 {"plan": null} when the project
// has no plan yet (not a 404, so a browser does not log a failed request for every project without one).
func (s *Server) latestPlan(w http.ResponseWriter, r *http.Request) {
	p, err := s.svc.LatestSessionPlan(r.Context(), r.PathValue("pid"), r.PathValue("sid"))
	if errors.Is(err, projectstore.ErrNotFound) {
		writeJSON(w, http.StatusOK, map[string]any{"plan": nil})
		return
	}
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"plan": p})
}

func (s *Server) approvePlan(w http.ResponseWriter, r *http.Request) {
	p, msg, err := s.svc.ApprovePlan(r.Context(), r.PathValue("pid"), r.PathValue("id"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"plan": p, "message": msg})
}

func (s *Server) rewind(w http.ResponseWriter, r *http.Request) {
	var in struct {
		MessageID int64 `json:"message_id"`
		DryRun    bool  `json:"dry_run"`
	}
	if !decode(w, r, &in) {
		return
	}
	rep, err := s.svc.RewindSession(r.Context(), r.PathValue("pid"), r.PathValue("sid"), in.MessageID, in.DryRun)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rep)
}

func (s *Server) compact(w http.ResponseWriter, r *http.Request) {
	// An ACP orchestrator that advertises a compact command gets "/compact" as a turn.
	msg, sent, err := s.svc.CompactViaAgentSession(r.Context(), r.PathValue("pid"), r.PathValue("sid"))
	if err != nil {
		writeErr(w, err)
		return
	}
	if sent {
		writeJSON(w, http.StatusAccepted, map[string]any{"sent_to_agent": true, "message": msg})
		return
	}
	res, err := s.svc.CompactSession(r.Context(), r.PathValue("pid"), r.PathValue("sid"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) exportConversation(w http.ResponseWriter, r *http.Request) {
	if f := r.URL.Query().Get("format"); f != "md" {
		writeError(w, http.StatusBadRequest, "invalid_request", "format must be md")
		return
	}
	name, md, err := s.svc.ExportSessionMarkdown(r.Context(), r.PathValue("pid"), r.PathValue("sid"))
	if err != nil {
		writeErr(w, err)
		return
	}
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(md))
}

func (s *Server) searchRequests(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	hits, err := s.svc.SearchRequests(r.Context(), r.URL.Query().Get("q"), limit)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": hits})
}
