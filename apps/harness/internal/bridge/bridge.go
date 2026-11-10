package bridge

import (
	"net/http"
	"regexp"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/project"
)

const (
	Version      = "0.2.0"
	pingInterval = 15 * time.Second
	maxBody      = 1 << 20
)

// Server is the HTTP + SSE face of the project service.
type Server struct {
	svc   *project.Service
	notes *project.Notes
	files *project.Files
	ping  time.Duration
}

func New(svc *project.Service, notes *project.Notes, files *project.Files) http.Handler {
	s := &Server{svc: svc, notes: notes, files: files, ping: pingInterval}
	return cors(s.routes())
}

func (s *Server) routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.health)
	mux.HandleFunc("GET /v1/config", s.config)
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
	mux.HandleFunc("GET /v1/projects/{pid}/notes", s.listNotes)
	mux.HandleFunc("POST /v1/projects/{pid}/notes", s.createNote)
	mux.HandleFunc("PATCH /v1/projects/{pid}/notes/{nid}", s.updateNote)
	mux.HandleFunc("DELETE /v1/projects/{pid}/notes/{nid}", s.deleteNote)
	mux.HandleFunc("GET /v1/projects/{pid}/files", s.listFiles)
	mux.HandleFunc("GET /v1/projects/{pid}/files/content", s.readFile)
	mux.HandleFunc("PUT /v1/projects/{pid}/files/content", s.writeFile)
	mux.HandleFunc("GET /v1/projects/{pid}/events", s.events)
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
