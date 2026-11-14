package bridge

import (
	"net/http"

	"github.com/ndolinschi/Octo/apps/harness/internal/project"
)

type mount struct {
	pattern string
	h       http.Handler
}

// WithMount serves h for a ServeMux pattern on the bridge, behind its API token and CORS like every /v1 route
// (remote access mounts its local control routes at /v1/remote this way).
func WithMount(pattern string, h http.Handler) Option {
	return func(s *Server) { s.mounts = append(s.mounts, mount{pattern, h}) }
}

// NewAPI is the bridge's routes with no API token, no CORS, no MCP server and no mounts: the inner handler of the
// remote-access listener, which authenticates paired devices itself and lets through only the routes its
// allow-list names (internal/remoteaccess). Never serve it without that gate in front.
func NewAPI(svc *project.Service, notes *project.Notes, files *project.Files, opts ...Option) http.Handler {
	s := &Server{svc: svc, notes: notes, files: files, ping: pingInterval}
	for _, o := range opts {
		o(s)
	}
	s.mcp, s.mounts, s.apiToken = nil, nil, ""
	return s.routes()
}
