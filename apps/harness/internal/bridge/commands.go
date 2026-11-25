package bridge

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"

	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/commands"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// WithCommands serves the project commands API (decision 68): suggestions,
// run, runs, stop, restart. Without it the routes answer 404 "no such route". A run is
// started only by this HTTP route; no agent tool and no MCP route calls it.
func WithCommands(svc *commands.Service) Option { return func(s *Server) { s.commands = svc } }

func (s *Server) commandRoutes(mux *http.ServeMux) {
	if s.commands == nil {
		return
	}
	mux.HandleFunc("GET /v1/projects/{pid}/commands/suggestions", s.commandSuggestions)
	mux.HandleFunc("POST /v1/projects/{pid}/commands/{name}/run", s.runCommand)
	mux.HandleFunc("POST /v1/projects/{pid}/runs", s.startAdhocRun)
	mux.HandleFunc("GET /v1/projects/{pid}/runs", s.listRuns)
	mux.HandleFunc("GET /v1/projects/{pid}/runs/{rid}", s.getRun)
	mux.HandleFunc("POST /v1/projects/{pid}/runs/{rid}/stop", s.stopRun)
	mux.HandleFunc("POST /v1/projects/{pid}/runs/{rid}/restart", s.restartRun)
}

func writeCommandErr(w http.ResponseWriter, err error) {
	var ce *commands.Error
	if errors.As(err, &ce) {
		status := map[commands.Kind]int{
			commands.KindInvalid:  http.StatusBadRequest,
			commands.KindNotFound: http.StatusNotFound,
			commands.KindConflict: http.StatusConflict,
		}[ce.Kind]
		writeError(w, status, ce.Code, ce.Message)
		return
	}
	writeErr(w, err)
}

func (s *Server) commandSuggestions(w http.ResponseWriter, r *http.Request) {
	list, err := s.commands.Suggestions(r.Context(), r.PathValue("pid"))
	if err != nil {
		writeCommandErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"suggestions": list})
}

func (s *Server) runCommand(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ReviewID string `json:"review_id"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody)).Decode(&in); err != nil && !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "invalid_request", "invalid JSON body: "+err.Error())
		return
	}
	run, err := s.commands.Start(r.Context(), r.PathValue("pid"), r.PathValue("name"), in.ReviewID)
	if err != nil {
		writeCommandErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"run_id": run.ID, "run": run})
}

func (s *Server) startAdhocRun(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name    string `json:"name"`
		Command string `json:"command"`
		Cwd     string `json:"cwd"`
	}
	if !decode(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.Command) == "" {
		writeProblem(w, http.StatusBadRequest, usererr.Generic("invalid_request", "command is required"))
		return
	}
	run, err := s.commands.StartAdhoc(r.Context(), r.PathValue("pid"), in.Name, in.Command, in.Cwd)
	if err != nil {
		writeCommandErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"run_id": run.ID, "run": run})
}

func (s *Server) listRuns(w http.ResponseWriter, r *http.Request) {
	limit := 0
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			writeError(w, http.StatusBadRequest, "invalid_request", "limit must be a positive integer")
			return
		}
		limit = n
	}
	list, err := s.commands.Runs(r.Context(), r.PathValue("pid"), r.URL.Query().Get("review_id"), limit)
	if err != nil {
		writeCommandErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"runs": list})
}

func (s *Server) getRun(w http.ResponseWriter, r *http.Request) {
	run, err := s.commands.Get(r.Context(), r.PathValue("pid"), r.PathValue("rid"))
	if err != nil {
		writeCommandErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, run)
}

func (s *Server) stopRun(w http.ResponseWriter, r *http.Request) {
	force := r.URL.Query().Get("force") == "1" || r.URL.Query().Get("force") == "true"
	var in struct {
		Force bool `json:"force"`
	}
	if r.Body != nil {
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody)).Decode(&in)
	}
	run, err := s.commands.StopWith(r.Context(), r.PathValue("pid"), r.PathValue("rid"), force || in.Force)
	if err != nil {
		writeCommandErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, run)
}

func (s *Server) restartRun(w http.ResponseWriter, r *http.Request) {
	run, err := s.commands.Restart(r.Context(), r.PathValue("pid"), r.PathValue("rid"))
	if err != nil {
		writeCommandErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"run_id": run.ID, "run": run})
}
