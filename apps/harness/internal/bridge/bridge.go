package bridge

import (
	"log/slog"
	"net/http"
	"runtime/debug"
	"slices"
	"strings"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/buildinfo"
	"github.com/ndolinschi/Octo/apps/harness/internal/commands"
	"github.com/ndolinschi/Octo/apps/harness/internal/mcp"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/review"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// Version is the harness version (internal/buildinfo, stamped by the build).
var Version = buildinfo.Version

const (
	pingInterval = 15 * time.Second
	maxBody      = 1 << 20
)

// Server is the HTTP + SSE face of the project service.
type Server struct {
	svc       *project.Service
	notes     *project.Notes
	files     *project.Files
	plugins   PluginSource
	langs     LanguageServers
	lsp       LSPSessions
	limits    LimitSource
	router    RouterInfo
	features  FeatureSource
	mcp       http.Handler
	reviews   *review.Service
	commands  *commands.Service
	browser   BrowserProxy
	workers   WorkerProcesses
	terminals TerminalSessions
	accounts  AccountEditor
	logins    AgentLogins

	settings         SettingsStore
	settingsLoopback bool
	ping             time.Duration

	diagnostics func() any
	builtinOff  string // reason the built-in loop is unavailable; "" = available
	builtinFn   func() (bool, string)
	providers   ProviderSource
	picker      picker
	defaultOrch func() string   // the orchestrator a project without a choice runs now
	apiToken    string          // required on /v1 routes when set (WithAPIToken)
	mounts      []mount         // extra handlers behind the token and CORS (WithMount)
	uiOrigins   map[string]bool // extra browser origins of the UI (WithUIOrigins), beside DefaultUIOrigins
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

// FeatureSource is the process-wide feature flags GET /v1/config reports.
type FeatureSource interface {
	Snapshot() map[string]bool
}

// WithFeatures reports live feature flags in GET /v1/config.
func WithFeatures(f FeatureSource) Option { return func(s *Server) { s.features = f } }

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
	return s.cors(s.recoverPanic(s.requireToken(s.routes())))
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
		if _, ok := s.providers.(ProviderEditor); ok {
			mux.HandleFunc("POST /v1/providers/{id}/refresh-models", s.refreshProviderModels)
			mux.HandleFunc("PUT /v1/providers/{id}/custom-models", s.putCustomModels)
			mux.HandleFunc("PUT /v1/providers/{id}/prefs", s.putProviderPrefs)
			mux.HandleFunc("POST /v1/providers/{id}/recheck", s.recheckProvider)
		}
	}
	s.accountRoutes(mux)
	s.agentLoginRoutes(mux)
	if s.diagnostics != nil {
		mux.HandleFunc("GET /v1/diagnostics", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, http.StatusOK, s.diagnostics()) })
	}
	mux.HandleFunc("GET /v1/fs/dirs", s.fsDirs)
	mux.HandleFunc("POST /v1/fs/pick-folder", s.pickFolder)
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
	mux.HandleFunc("POST /v1/projects/{pid}/attachments", s.uploadAttachment)
	mux.HandleFunc("GET /v1/projects/{pid}/attachments/{id}", s.getAttachment)
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
	mux.HandleFunc("POST /v1/projects/{pid}/side/stop", s.stopSide)
	mux.HandleFunc("GET /v1/projects/{pid}/side", s.listSide)
	mux.HandleFunc("DELETE /v1/projects/{pid}/side", s.clearSide)
	mux.HandleFunc("GET /v1/projects/{pid}/notes", s.listNotes)
	mux.HandleFunc("POST /v1/projects/{pid}/notes", s.createNote)
	mux.HandleFunc("GET /v1/projects/{pid}/notes/{nid}", s.getNote)
	mux.HandleFunc("GET /v1/projects/{pid}/notes/{nid}/export", s.exportNote)
	mux.HandleFunc("PATCH /v1/projects/{pid}/notes/{nid}", s.updateNote)
	mux.HandleFunc("DELETE /v1/projects/{pid}/notes/{nid}", s.deleteNote)
	mux.HandleFunc("GET /v1/projects/{pid}/files", s.listFiles)
	mux.HandleFunc("GET /v1/projects/{pid}/files/search", s.searchFiles)
	mux.HandleFunc("GET /v1/projects/{pid}/files/content", s.readFile)
	mux.HandleFunc("PUT /v1/projects/{pid}/files/content", s.writeFile)
	mux.HandleFunc("POST /v1/projects/{pid}/files/mkdir", s.mkdirFile)
	mux.HandleFunc("POST /v1/projects/{pid}/files/rename", s.renameFile)
	mux.HandleFunc("DELETE /v1/projects/{pid}/files/entry", s.deleteFileEntry)
	mux.HandleFunc("GET /v1/projects/{pid}/changes", s.listChanges)
	mux.HandleFunc("GET /v1/projects/{pid}/changes/{cid}", s.getChange)
	mux.HandleFunc("POST /v1/projects/{pid}/changes/{cid}/revert", s.revertChange)
	mux.HandleFunc("GET /v1/projects/{pid}/approvals", s.listApprovals)
	mux.HandleFunc("POST /v1/projects/{pid}/approvals/{id}", s.resolveApproval)
	mux.HandleFunc("POST /v1/projects/{pid}/rewind", s.rewind)
	mux.HandleFunc("POST /v1/projects/{pid}/compact", s.compact)
	mux.HandleFunc("POST /v1/projects/{pid}/clear", s.clearConversation)
	mux.HandleFunc("POST /v1/projects/{pid}/facts", s.rememberFact)
	mux.HandleFunc("DELETE /v1/projects/{pid}/facts/{tid}/{fid}", s.forgetFact)
	mux.HandleFunc("GET /v1/projects/{pid}/slash-commands", s.slashCommands)
	mux.HandleFunc("GET /v1/projects/{pid}/export", s.exportConversation)
	mux.HandleFunc("GET /v1/search", s.searchRequests)
	mux.HandleFunc("GET /v1/projects/{pid}/plans/latest", s.latestPlan)
	mux.HandleFunc("POST /v1/projects/{pid}/plans/{id}/approve", s.approvePlan)
	mux.HandleFunc("GET /v1/projects/{pid}/approval-rules", s.listApprovalRules)
	mux.HandleFunc("DELETE /v1/projects/{pid}/approval-rules/{rid}", s.deleteApprovalRule)
	mux.HandleFunc("GET /v1/projects/{pid}/inputs", s.listInputs)
	mux.HandleFunc("POST /v1/projects/{pid}/inputs/{id}", s.submitInput)
	mux.HandleFunc("GET /v1/projects/{pid}/secrets", s.listSecrets)
	mux.HandleFunc("PUT /v1/projects/{pid}/secrets/{name}", s.putSecret)
	mux.HandleFunc("DELETE /v1/projects/{pid}/secrets/{name}", s.deleteSecret)
	mux.HandleFunc("GET /v1/projects/{pid}/tasks", s.listTasks)
	mux.HandleFunc("GET /v1/projects/{pid}/turns/{tid}/context", s.turnContext)
	mux.HandleFunc("GET /v1/projects/{pid}/memory", s.listMemory)
	mux.HandleFunc("GET /v1/projects/{pid}/memory/search", s.searchMemory)
	mux.HandleFunc("GET /v1/projects/{pid}/workspaces", s.listWorkspaces)
	mux.HandleFunc("GET /v1/projects/{pid}/branches", s.listBranches)
	mux.HandleFunc("POST /v1/projects/{pid}/branches/switch", s.switchBranch)
	mux.HandleFunc("GET /v1/projects/{pid}/sessions", s.listSessions)
	mux.HandleFunc("POST /v1/projects/{pid}/sessions", s.createSession)
	mux.HandleFunc("DELETE /v1/projects/{pid}/sessions", s.deleteProjectSessions)
	mux.HandleFunc("POST /v1/projects/{pid}/sessions/import", s.importSessions)
	mux.HandleFunc("GET /v1/projects/{pid}/sessions/{sid}", s.getSession)
	mux.HandleFunc("PATCH /v1/projects/{pid}/sessions/{sid}", s.patchSession)
	mux.HandleFunc("DELETE /v1/projects/{pid}/sessions/{sid}", s.deleteSession)
	mux.HandleFunc("GET /v1/projects/{pid}/sessions/{sid}/messages", s.sessionMessages)
	mux.HandleFunc("POST /v1/projects/{pid}/sessions/{sid}/resume", s.resumeSession)
	mux.HandleFunc("POST /v1/projects/{pid}/sessions/{sid}/default", s.resumeSession)
	mux.HandleFunc("POST /v1/projects/{pid}/sessions/{sid}/stop", s.stopSession)
	mux.HandleFunc("POST /v1/projects/{pid}/sessions/{sid}/worktree", s.moveSessionToWorktree)
	mux.HandleFunc("POST /v1/projects/{pid}/sessions/{sid}/messages", s.messageSession)
	// Parallel sessions (phase 1): the project routes of the same name, for one main session ({sid}); without
	// {sid} they act on the default session.
	mux.HandleFunc("GET /v1/projects/{pid}/sessions/{sid}/queue", s.getQueue)
	mux.HandleFunc("DELETE /v1/projects/{pid}/sessions/{sid}/queue", s.clearQueue)
	mux.HandleFunc("POST /v1/projects/{pid}/sessions/{sid}/queue/resume", s.resumeQueue)
	mux.HandleFunc("PATCH /v1/projects/{pid}/sessions/{sid}/queue/{qid}", s.editQueued)
	mux.HandleFunc("DELETE /v1/projects/{pid}/sessions/{sid}/queue/{qid}", s.removeQueued)
	mux.HandleFunc("POST /v1/projects/{pid}/sessions/{sid}/queue/{qid}/send-now", s.sendNow)
	mux.HandleFunc("GET /v1/projects/{pid}/sessions/{sid}/context", s.context)
	mux.HandleFunc("POST /v1/projects/{pid}/sessions/{sid}/compact", s.compact)
	mux.HandleFunc("POST /v1/projects/{pid}/sessions/{sid}/clear", s.clearSessionConversation)
	mux.HandleFunc("POST /v1/projects/{pid}/sessions/{sid}/rewind", s.rewind)
	mux.HandleFunc("GET /v1/projects/{pid}/sessions/{sid}/plans/latest", s.latestPlan)
	mux.HandleFunc("GET /v1/projects/{pid}/sessions/{sid}/export", s.exportConversation)
	mux.HandleFunc("GET /v1/sessions", s.listAllSessions)
	mux.HandleFunc("DELETE /v1/sessions", s.deleteAllSessions)
	mux.HandleFunc("GET /v1/sessions/importable", s.listImportableSessions)
	mux.HandleFunc("GET /v1/projects/{pid}/memory/sessions", s.listMemorySessions)
	mux.HandleFunc("GET /v1/projects/{pid}/memory/sessions/{sid}", s.getMemorySession)
	mux.HandleFunc("DELETE /v1/projects/{pid}/memory/exchanges/{eid}", s.forgetExchange)
	mux.HandleFunc("GET /v1/projects/{pid}/memory/{name...}", s.getMemoryFile)
	mux.HandleFunc("PUT /v1/projects/{pid}/memory/{name...}", s.putMemoryFile)
	mux.HandleFunc("DELETE /v1/projects/{pid}/memory/{name...}", s.deleteMemoryFile)
	mux.HandleFunc("GET /v1/projects/{pid}/events", s.events)
	mux.HandleFunc("GET /v1/projects/{pid}/lsp", s.listLSP)
	mux.HandleFunc("POST /v1/projects/{pid}/lsp/{server}/sessions", s.createLSPSession)
	mux.HandleFunc("POST /v1/projects/{pid}/lsp/sessions/{sid}/messages", s.postLSPMessage)
	mux.HandleFunc("GET /v1/projects/{pid}/lsp/sessions/{sid}/events", s.lspEvents)
	mux.HandleFunc("DELETE /v1/projects/{pid}/lsp/sessions/{sid}", s.deleteLSPSession)
	s.reviewRoutes(mux)
	s.commandRoutes(mux)
	s.browserRoutes(mux)
	s.processRoutes(mux)
	s.terminalRoutes(mux)
	for _, m := range s.mounts {
		mux.Handle(m.pattern, m.h)
	}
	if s.mcp != nil {
		mux.Handle(mcp.PathPrefix, s.mcp)
	}
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not_found", "no such route")
	})
	return mux
}

// DefaultUIOrigins are the browser origins of the UI that may call the bridge: the desktop shell's webview
// (tauri://localhost on macOS and Linux, http://tauri.localhost on Windows) and the UI dev server on its default
// port. Any other localhost origin (the Browser tab's proxy on an ephemeral port, another dev server) is not the UI:
// it gets no CORS answer, and the settings routes refuse it. A dev server on another port is added with
// HARNESS_UI_ORIGINS (WithUIOrigins); scripts/dev.sh sets it.
var DefaultUIOrigins = []string{"tauri://localhost", "http://tauri.localhost", "http://localhost:1420", "http://127.0.0.1:1420"}

// ParseUIOrigins reads HARNESS_UI_ORIGINS: comma-separated origins (scheme://host[:port]); a trailing slash is dropped.
func ParseUIOrigins(v string) []string {
	var out []string
	for _, o := range strings.Split(v, ",") {
		if o = strings.TrimRight(strings.TrimSpace(o), "/"); o != "" {
			out = append(out, o)
		}
	}
	return out
}

// WithUIOrigins allows these browser origins besides DefaultUIOrigins.
func WithUIOrigins(origins []string) Option {
	return func(s *Server) {
		if s.uiOrigins == nil {
			s.uiOrigins = map[string]bool{}
		}
		for _, o := range origins {
			s.uiOrigins[o] = true
		}
	}
}

// originAllowed says origin is the UI's.
func (s *Server) originAllowed(origin string) bool {
	return slices.Contains(DefaultUIOrigins, origin) || s.uiOrigins[origin]
}

func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); origin != "" && s.originAllowed(origin) {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			h.Add("Vary", "Origin")
			h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
			h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Last-Event-ID")
			h.Set("Access-Control-Max-Age", "600")
			// The UI reads the clock of the answers (relative times on a machine whose clock is off).
			h.Set("Access-Control-Expose-Headers", "Date")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

type statusWriter struct {
	http.ResponseWriter
	wroteHeader bool
}

func (w *statusWriter) WriteHeader(code int) {
	w.wroteHeader = true
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(p []byte) (int, error) {
	w.wroteHeader = true
	return w.ResponseWriter.Write(p)
}

func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (w *statusWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func (s *Server) recoverPanic(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sw := &statusWriter{ResponseWriter: w}
		defer func() {
			if rec := recover(); rec != nil {
				if rec == http.ErrAbortHandler {
					panic(rec)
				}
				slog.Error("http handler panic", "method", r.Method, "path", r.URL.Path, "panic", rec, "stack", string(debug.Stack()))
				if !sw.wroteHeader {
					writeProblem(sw, http.StatusInternalServerError, usererr.Generic("internal", "internal error"))
				}
			}
		}()
		next.ServeHTTP(sw, r)
	})
}
