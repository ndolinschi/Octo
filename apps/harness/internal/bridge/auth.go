package bridge

import (
	"net/http"
	"regexp"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/apitoken"
)

// WithAPIToken makes every /v1 route require "Authorization: Bearer <token>".
// /health and the MCP routes (which have their own per-session tokens) stay
// open, and so does a CORS preflight. The SSE routes also take the token
// as a ?token= query parameter, because a browser EventSource cannot set
// headers. An empty token leaves the bridge open (tests, --no-api-token).
func WithAPIToken(token string) Option { return func(s *Server) { s.apiToken = token } }

// sseRoute matches the routes a browser opens with EventSource: the project
// event stream, a language-server session's stream, a terminal session's stream, and an agent login's stream.
var sseRoute = regexp.MustCompile(`^/v1/(projects/[^/]+(/events|/lsp/sessions/[^/]+/events|/terminals/[^/]+/events)|providers/[^/]+/login/[^/]+/events)$`)

const unauthorizedMessage = "missing or invalid API token: send Authorization: Bearer <token> " +
	"(the token is HARNESS_API_TOKEN, or the file api-token in the harness data directory)"

func (s *Server) requireToken(next http.Handler) http.Handler {
	if s.apiToken == "" {
		return next
	}
	m, err := apitoken.NewMatcher(s.apiToken)
	if err != nil {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/v1/") {
			next.ServeHTTP(w, r)
			return
		}
		if m.Match(presentedToken(r)) {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("WWW-Authenticate", `Bearer realm="harness"`)
		writeError(w, http.StatusUnauthorized, "unauthorized", unauthorizedMessage)
	})
}

// presentedToken is the bearer token of the request: the Authorization header
// when there is one (a wrong header is never rescued by a query parameter), else
// ?token= on an SSE route only.
func presentedToken(r *http.Request) string {
	if h := r.Header.Get("Authorization"); h != "" {
		scheme, tok, ok := strings.Cut(h, " ")
		if ok && strings.EqualFold(scheme, "Bearer") {
			return tok
		}
		return ""
	}
	if r.Method == http.MethodGet && sseRoute.MatchString(r.URL.Path) {
		return r.URL.Query().Get("token")
	}
	return ""
}
