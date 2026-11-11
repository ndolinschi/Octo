package bridge

import (
	"net/http"
	"regexp"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/mcp"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
)

const (
	Version      = "0.2.0"
	pingInterval = 15 * time.Second
	maxBody      = 1 << 20
)

// Server is the HTTP + SSE face of the project service.
type Server struct {
	svc     *project.Service
	notes   *project.Notes
	files   *project.Files
	plugins PluginSource
	langs   LanguageServers
	lsp     LSPSessions
	limits  LimitSource
	router  RouterInfo
	mcp     http.Handler

	settings         SettingsStore
	settingsLoopback bool
	ping             time.Duration

	diagnostics func() any
	builtinOff  string // reason the built-in loop is unavailable; "" = available
	builtinFn   func() (bool, string)
	providers   ProviderSource
	defaultOrch func() string // the orchestrator a project without a choice runs now
}

// PluginSource is the read-only plugin view GET /v1/plugins serves.
type PluginSource interface {
	Plugins() []plugins.Plugin
}

// RouterInfo is the Octo router detection GET /v1/config reports.
type RouterInfo interface {
	Enabled() bool
	Capabilities() []string
}

// WithRouter reports the detected Octo router in GET /v1/config.
func WithRouter(r RouterInfo) Option { return func(s *Server) { s.router = r } }

// Option customizes the server.
type Option func(*Server)

// WithPlugins serves the registry at GET /v1/plugins (empty list otherwise).
func WithPlugins(src PluginSource) Option { return func(s *Server) { s.plugins = src } }

// WithMCP mounts the harness's MCP server (for ACP orchestrators) at
// mcp.PathPrefix. It authenticates by per-session bearer token itself.
func WithMCP(h http.Handler) Option { return func(s *Server) { s.mcp = h } }

// WithBuiltinLoop reports in GET /v1/config whether the built-in agent loop
// can run (reason says why not). Without it the loop is reported available.
func WithBuiltinLoop(available bool, reason string) Option {
	return func(s *Server) {
		if !available {
			s.builtinOff = reason
			if reason == "" {
				s.builtinOff = "unavailable"
			}
		}
	}
}

// WithDefaultOrchestrator supplies default_orchestrator of GET /v1/config.
// Without it the server default model is reported.
func WithDefaultOrchestrator(f func() string) Option { return func(s *Server) { s.defaultOrch = f } }

// WithDiagnostics serves GET /v1/diagnostics from f (the report as a JSON value).
func WithDiagnostics(f func() any) Option { return func(s *Server) { s.diagnostics = f } }

// WithPingInterval overrides the SSE keep-alive period.
func WithPingInterval(d time.Duration) Option { return func(s *Server) { s.ping = d } }

func New(svc *project.Service, notes *project.Notes, files *project.Files, opts ...Option) http.Handler {
	s := &Server{svc: svc, notes: notes, files: files, ping: pingInterval}
	for _, o := range opts {
		o(s)
	}
	return cors(s.routes())
}

func (s *Server) routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.health)
	mux.HandleFunc("GET /v1/config", s.config)
	mux.HandleFunc("GET /v1/plugins", s.listPlugins)
	if s.settings != nil {
		mux.HandleFunc("GET /v1/settings", s.getSettings)
		mux.HandleFunc("PUT /v1/settings", s.putSettings)
	}
	if s.providers != nil {
		mux.HandleFunc("GET /v1/providers", s.listProviders)
	}
	if s.diagnostics != nil {
		mux.HandleFunc("GET /v1/diagnostics", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, http.StatusOK, s.diagnostics()) })
	}
	mux.HandleFunc("GET /v1/fs/dirs", s.fsDirs)
	mux.HandleFunc("GET /v1/fs/recent", s.fsRecent)
	mux.HandleFunc("GET /v1/usage", s.usage)
	mux.HandleFunc("GET /v1/limits", s.listLimits)
	mux.HandleFunc("GET /v1/projects", s.listProjects)
	mux.HandleFunc("POST /v1/projects", s.createProject)
	mux.HandleFunc("GET /v1/projects/{pid}", s.getProject)
	mux.HandleFunc("PATCH /v1/projects/{pid}", s.updateProject)
	mux.HandleFunc("DELETE /v1/projects/{pid}", s.deleteProject)
	mux.HandleFunc("GET /v1/projects/{pid}/agents", s.listAgents)
	mux.HandleFunc("GET /v1/projects/{pid}/agents/{aid}", s.getAgent)
	mux.HandleFunc("GET /v1/projects/{pid}/agents/{aid}/messages", s.agentMessages)
	mux.HandleFunc("POST /v1/projects/{pid}/messages", s.postMessage)
	mux.HandleFunc("POST /v1/projects/{pid}/cancel", s.cancel)
	mux.HandleFunc("GET /v1/projects/{pid}/queue", s.getQueue)
	mux.HandleFunc("DELETE /v1/projects/{pid}/queue", s.clearQueue)
	mux.HandleFunc("POST /v1/projects/{pid}/queue/resume", s.resumeQueue)
	mux.HandleFunc("PATCH /v1/projects/{pid}/queue/{qid}", s.editQueued)
	mux.HandleFunc("DELETE /v1/projects/{pid}/queue/{qid}", s.removeQueued)
	mux.HandleFunc("POST /v1/projects/{pid}/queue/{qid}/send-now", s.sendNow)
	mux.HandleFunc("GET /v1/projects/{pid}/context", s.context)
	mux.HandleFunc("POST /v1/projects/{pid}/complete", s.complete)
	mux.HandleFunc("POST /v1/projects/{pid}/side", s.askSide)
	mux.HandleFunc("GET /v1/projects/{pid}/side", s.listSide)
	mux.HandleFunc("DELETE /v1/projects/{pid}/side", s.clearSide)
	mux.HandleFunc("GET /v1/projects/{pid}/notes", s.listNotes)
	mux.HandleFunc("POST /v1/projects/{pid}/notes", s.createNote)
	mux.HandleFunc("PATCH /v1/projects/{pid}/notes/{nid}", s.updateNote)
	mux.HandleFunc("DELETE /v1/projects/{pid}/notes/{nid}", s.deleteNote)
	mux.HandleFunc("GET /v1/projects/{pid}/files", s.listFiles)
	mux.HandleFunc("GET /v1/projects/{pid}/files/content", s.readFile)
	mux.HandleFunc("PUT /v1/projects/{pid}/files/content", s.writeFile)
	mux.HandleFunc("GET /v1/projects/{pid}/changes", s.listChanges)
	mux.HandleFunc("GET /v1/projects/{pid}/changes/{cid}", s.getChange)
	mux.HandleFunc("POST /v1/projects/{pid}/changes/{cid}/revert", s.revertChange)
	mux.HandleFunc("GET /v1/projects/{pid}/approvals", s.listApprovals)
	mux.HandleFunc("POST /v1/projects/{pid}/approvals/{id}", s.resolveApproval)
	mux.HandleFunc("GET /v1/projects/{pid}/inputs", s.listInputs)
	mux.HandleFunc("POST /v1/projects/{pid}/inputs/{id}", s.submitInput)
	mux.HandleFunc("GET /v1/projects/{pid}/secrets", s.listSecrets)
	mux.HandleFunc("PUT /v1/projects/{pid}/secrets/{name}", s.putSecret)
	mux.HandleFunc("DELETE /v1/projects/{pid}/secrets/{name}", s.deleteSecret)
	mux.HandleFunc("GET /v1/projects/{pid}/tasks", s.listTasks)
	mux.HandleFunc("GET /v1/projects/{pid}/turns/{tid}/context", s.turnContext)
	mux.HandleFunc("GET /v1/projects/{pid}/memory", s.listMemory)
	mux.HandleFunc("GET /v1/projects/{pid}/memory/search", s.searchMemory)
	mux.HandleFunc("GET /v1/projects/{pid}/memory/{name...}", s.getMemoryFile)
	mux.HandleFunc("PUT /v1/projects/{pid}/memory/{name...}", s.putMemoryFile)
	mux.HandleFunc("DELETE /v1/projects/{pid}/memory/{name...}", s.deleteMemoryFile)
	mux.HandleFunc("GET /v1/projects/{pid}/events", s.events)
	mux.HandleFunc("GET /v1/projects/{pid}/lsp", s.listLSP)
	mux.HandleFunc("POST /v1/projects/{pid}/lsp/{server}/sessions", s.createLSPSession)
	mux.HandleFunc("POST /v1/projects/{pid}/lsp/sessions/{sid}/messages", s.postLSPMessage)
	mux.HandleFunc("GET /v1/projects/{pid}/lsp/sessions/{sid}/events", s.lspEvents)
	mux.HandleFunc("DELETE /v1/projects/{pid}/lsp/sessions/{sid}", s.deleteLSPSession)
	if s.mcp != nil {
		mux.Handle(mcp.PathPrefix, s.mcp)
	}
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not_found", "no such route")
	})
	return mux
}

var allowedOrigin = regexp.MustCompile(`^(https?://(localhost|127\.0\.0\.1)(:\d+)?|tauri://localhost|http://tauri\.localhost)$`)

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); origin != "" && allowedOrigin.MatchString(origin) {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			h.Add("Vary", "Origin")
			h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
			h.Set("Access-Control-Allow-Headers", "Content-Type, Last-Event-ID")
			h.Set("Access-Control-Max-Age", "600")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
