package bridge

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/lsp"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// WorkerProcesses exposes live ACP agent subprocesses managed by the orchestrator.
type WorkerProcesses interface {
	WorkerProcesses(projectID string) []orchestrator.WorkerProcess
	StopWorkerProcess(projectID, sessionID string) bool
}

// WithWorkerProcesses attaches live ACP subprocess inspection and stop controls.
func WithWorkerProcesses(wp WorkerProcesses) Option {
	return func(s *Server) { s.workers = wp }
}

type lspProcessInspector interface {
	ListProject(project string) []lsp.SessionInfo
	Restart(ctx context.Context, project, id string) (*lsp.Session, error)
}

type workerProcessDTO struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Command   string `json:"command"`
	Cwd       string `json:"cwd,omitempty"`
	PID       int    `json:"pid"`
	Status    string `json:"status"`
	StartedAt string `json:"started_at"`
	Detail    string `json:"detail,omitempty"`
	Output    string `json:"output,omitempty"`
}

func (s *Server) processRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/projects/{pid}/processes", s.listProcesses)
	mux.HandleFunc("POST /v1/projects/{pid}/processes/{procid}/stop", s.stopProcess)
	mux.HandleFunc("POST /v1/projects/{pid}/processes/{procid}/restart", s.restartProcess)
}

func (s *Server) listProcesses(w http.ResponseWriter, r *http.Request) {
	pid := r.PathValue("pid")
	if _, err := s.svc.Get(r.Context(), pid); err != nil {
		writeErr(w, err)
		return
	}
	out := []workerProcessDTO{}
	if li, ok := s.lsp.(lspProcessInspector); ok {
		for _, info := range li.ListProject(pid) {
			out = append(out, lspInfoDTO(info))
		}
	}
	if s.workers != nil {
		for _, wp := range s.workers.WorkerProcesses(pid) {
			status := "idle"
			if wp.Busy {
				status = "busy"
			}
			started := ""
			if !wp.StartedAt.IsZero() {
				started = wp.StartedAt.UTC().Format(time.RFC3339Nano)
			}
			out = append(out, workerProcessDTO{
				ID:        wp.ID,
				Kind:      "agent",
				Name:      wp.Name,
				Command:   wp.Command,
				Cwd:       wp.Cwd,
				PID:       wp.PID,
				Status:    status,
				StartedAt: started,
				Detail:    wp.Model,
				Output:    wp.Stderr,
			})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"processes": out})
}

func lspInfoDTO(info lsp.SessionInfo) workerProcessDTO {
	cmdLine := strings.TrimSpace(info.Spec.Command + " " + strings.Join(info.Spec.Args, " "))
	name := info.Spec.Name
	if name == "" {
		name = info.Spec.Command
	}
	status := "idle"
	if info.Subscribed {
		status = "running"
	}
	started := ""
	if !info.StartedAt.IsZero() {
		started = info.StartedAt.UTC().Format(time.RFC3339Nano)
	}
	return workerProcessDTO{
		ID:        "lsp:" + info.ID,
		Kind:      "lsp",
		Name:      name,
		Command:   cmdLine,
		Cwd:       info.Spec.Dir,
		PID:       info.PID,
		Status:    status,
		StartedAt: started,
		Detail:    "Language server",
		Output:    info.StderrTail,
	}
}

func (s *Server) stopProcess(w http.ResponseWriter, r *http.Request) {
	pid := r.PathValue("pid")
	if _, err := s.svc.Get(r.Context(), pid); err != nil {
		writeErr(w, err)
		return
	}
	procID := r.PathValue("procid")
	switch {
	case strings.HasPrefix(procID, "lsp:") && s.lsp != nil:
		sid := strings.TrimPrefix(procID, "lsp:")
		if err := s.lsp.Close(pid, sid); err != nil {
			if errors.Is(err, lsp.ErrNotFound) {
				writeProblem(w, http.StatusNotFound, usererr.NotFoundWhat("process"))
				return
			}
			writeErr(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	case strings.HasPrefix(procID, "acp:") && s.workers != nil:
		sid := strings.TrimPrefix(procID, "acp:")
		if !s.workers.StopWorkerProcess(pid, sid) {
			writeProblem(w, http.StatusNotFound, usererr.NotFoundWhat("process"))
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		writeProblem(w, http.StatusNotFound, usererr.NotFoundWhat("process"))
	}
}

func (s *Server) restartProcess(w http.ResponseWriter, r *http.Request) {
	pid := r.PathValue("pid")
	if _, err := s.svc.Get(r.Context(), pid); err != nil {
		writeErr(w, err)
		return
	}
	procID := r.PathValue("procid")
	switch {
	case strings.HasPrefix(procID, "lsp:"):
		li, ok := s.lsp.(lspProcessInspector)
		if !ok {
			writeProblem(w, http.StatusNotFound, usererr.NotFoundWhat("process"))
			return
		}
		sid := strings.TrimPrefix(procID, "lsp:")
		sess, err := li.Restart(r.Context(), pid, sid)
		if err != nil {
			if errors.Is(err, lsp.ErrNotFound) {
				writeProblem(w, http.StatusNotFound, usererr.NotFoundWhat("process"))
				return
			}
			writeProblem(w, http.StatusConflict, usererr.CommandFailed(err.Error()))
			return
		}
		dto := lspInfoDTO(lsp.SessionInfo{
			ID:         sess.ID,
			Project:    sess.Project,
			Spec:       sess.Spec(),
			PID:        sess.PID(),
			StartedAt:  sess.StartedAt(),
			Subscribed: false,
			StderrTail: sess.StderrTail(),
		})
		writeJSON(w, http.StatusOK, map[string]any{"process": dto})
	case strings.HasPrefix(procID, "acp:") && s.workers != nil:
		sid := strings.TrimPrefix(procID, "acp:")
		if !s.workers.StopWorkerProcess(pid, sid) {
			writeProblem(w, http.StatusNotFound, usererr.NotFoundWhat("process"))
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"process": nil})
	default:
		writeProblem(w, http.StatusNotFound, usererr.NotFoundWhat("process"))
	}
}
