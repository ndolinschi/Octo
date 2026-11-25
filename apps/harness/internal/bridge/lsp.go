package bridge

import (
	"context"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/lsp"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
)

// LanguageServers is the plugin registry's language-server view.
type LanguageServers interface {
	LanguageServers() []plugins.LanguageServer
	LanguageServer(id string) (plugins.LanguageServer, bool)
}

// LSPSessions is the session manager the LSP endpoints drive.
type LSPSessions interface {
	Start(ctx context.Context, project string, spec lsp.Spec) (*lsp.Session, error)
	Get(project, id string) (*lsp.Session, error)
	Close(project, id string) error
	CloseProject(project string)
}

// WithLSP enables the language-server endpoints.
func WithLSP(servers LanguageServers, sessions LSPSessions) Option {
	return func(s *Server) { s.langs, s.lsp = servers, sessions }
}

type lspServer struct {
	ID        string   `json:"id"`
	Label     string   `json:"label"`
	Languages []string `json:"languages"`
	Available bool     `json:"available"`
}

type lspFolder struct {
	URI  string `json:"uri"`
	Name string `json:"name"`
}

func (s *Server) listLSP(w http.ResponseWriter, r *http.Request) {
	if _, err := s.svc.Get(r.Context(), r.PathValue("pid")); err != nil {
		writeErr(w, err)
		return
	}
	servers := []lspServer{}
	if s.langs != nil {
		for _, ls := range s.langs.LanguageServers() {
			langs := ls.Languages
			if langs == nil {
				langs = []string{}
			}
			servers = append(servers, lspServer{ID: ls.ID, Label: ls.Label, Languages: langs, Available: ls.Available})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"servers": servers})
}

func (s *Server) createLSPSession(w http.ResponseWriter, r *http.Request) {
	pid := r.PathValue("pid")
	proj, err := s.svc.Get(r.Context(), pid)
	if err != nil {
		writeErr(w, err)
		return
	}
	if s.langs == nil || s.lsp == nil {
		writeError(w, http.StatusNotFound, "not_found", "language server not found")
		return
	}
	ls, ok := s.langs.LanguageServer(r.PathValue("server"))
	if !ok || !ls.Available {
		writeError(w, http.StatusNotFound, "not_found", "language server not found or unavailable")
		return
	}
	if len(proj.Folders) == 0 {
		writeErr(w, &project.Error{Kind: project.KindInvalid, Code: "invalid_request", Message: "project has no folders"})
		return
	}
	folders := make([]lspFolder, 0, len(proj.Folders))
	for _, f := range proj.Folders {
		folders = append(folders, lspFolder{URI: fileURI(f.Path), Name: f.Label})
	}
	dir := proj.Folders[0].Path
	if r.URL.Query().Get("workspace") == "review" {
		// The review workspace (a review's worktree) instead of the project's folders.
		if proj.ReviewWorkspace == nil {
			writeError(w, http.StatusConflict, "no_review_workspace", "no review is open in the workspace")
			return
		}
		dir = proj.ReviewWorkspace.Path
		folders = []lspFolder{{URI: fileURI(dir), Name: "@review"}}
	}
	sess, err := s.lsp.Start(r.Context(), pid, lsp.Spec{
		Name: ls.ID, Command: ls.Command, Args: ls.Args, Env: ls.Env, Dir: dir,
	})
	if err != nil {
		writeLSPErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"session_id": sess.ID, "root_uri": folders[0].URI, "workspace_folders": folders,
	})
}

// fileURI turns an absolute filesystem path into a percent-encoded file URI.
func fileURI(path string) string {
	if abs, err := filepath.Abs(path); err == nil {
		path = abs
	}
	p := filepath.ToSlash(path)
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	return (&url.URL{Scheme: "file", Path: p}).String()
}
