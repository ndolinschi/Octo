package bridge

import (
	"net/http"

	"github.com/ndolinschi/Octo/apps/harness/internal/providers"
)

// ProviderSource is what GET /v1/providers serves (providers.Service).
type ProviderSource interface {
	Snapshot() providers.Response
}

// WithProviders serves GET /v1/providers.
func WithProviders(p ProviderSource) Option { return func(s *Server) { s.providers = p } }

// WithBuiltinLoopFunc is WithBuiltinLoop for a state that changes while the
// server runs (an API key written through the settings screen): f is asked on
// every GET /v1/config.
func WithBuiltinLoopFunc(f func() (available bool, reason string)) Option {
	return func(s *Server) { s.builtinFn = f }
}

// builtinState is whether the built-in loop can run and why not.
func (s *Server) builtinState() (bool, string) {
	if s.builtinFn != nil {
		ok, reason := s.builtinFn()
		if !ok && reason == "" {
			reason = "unavailable"
		}
		return ok, reason
	}
	return s.builtinOff == "", s.builtinOff
}

func (s *Server) listProviders(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.providers.Snapshot())
}
