package bridge

import (
	"context"
	"net/http"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/terminal"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// TerminalSessions is the session manager the terminal endpoints drive.
type TerminalSessions interface {
	Start(ctx context.Context, project string, spec terminal.Spec) (*terminal.Session, error)
	Get(project, id string) (*terminal.Session, error)
	Close(project, id string) error
	CloseProject(project string)
}

// WithTerminals enables the interactive PTY terminal endpoints.
func WithTerminals(sessions TerminalSessions) Option {
	return func(s *Server) { s.terminals = sessions }
}

func (s *Server) terminalRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/projects/{pid}/terminals", s.createTerminalSession)
	mux.HandleFunc("GET /v1/projects/{pid}/terminals/{tid}/events", s.terminalEvents)
	mux.HandleFunc("POST /v1/projects/{pid}/terminals/{tid}/input", s.postTerminalInput)
	mux.HandleFunc("POST /v1/projects/{pid}/terminals/{tid}/resize", s.resizeTerminalSession)
	mux.HandleFunc("DELETE /v1/projects/{pid}/terminals/{tid}", s.deleteTerminalSession)
}

func (s *Server) createTerminalSession(w http.ResponseWriter, r *http.Request) {
	pid := r.PathValue("pid")
	proj, err := s.svc.Get(r.Context(), pid)
	if err != nil {
		writeErr(w, err)
		return
	}
	if s.terminals == nil {
		writeProblem(w, http.StatusNotFound, usererr.NotFoundWhat("terminal"))
		return
	}
	if len(proj.Folders) == 0 {
		writeProblem(w, http.StatusBadRequest, usererr.Generic("no_folder", "project has no folders"))
		return
	}
	var in struct {
		Folder string `json:"folder"`
		Cols   int    `json:"cols"`
		Rows   int    `json:"rows"`
	}
	if r.ContentLength != 0 && !decode(w, r, &in) {
		return
	}
	chosen := proj.Folders[0]
	if want := strings.TrimSpace(in.Folder); want != "" {
		found := false
		for _, f := range proj.Folders {
			if strings.EqualFold(f.Label, want) || f.Path == want {
				chosen = f
				found = true
				break
			}
		}
		if !found {
			writeProblem(w, http.StatusBadRequest, usererr.Generic("unknown_folder", "unknown project folder: "+want))
			return
		}
	}
	sess, err := s.terminals.Start(r.Context(), pid, terminal.Spec{
		Folder: chosen.Label,
		Dir:    chosen.Path,
		Cols:   in.Cols,
		Rows:   in.Rows,
	})
	if err != nil {
		writeTerminalErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"session_id": sess.ID,
		"folder":     chosen.Label,
		"cwd":        chosen.Path,
		"shell":      sess.Shell(),
		"pid":        sess.PID(),
	})
}
