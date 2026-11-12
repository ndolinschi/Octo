package bridge

import (
	"context"
	"errors"
	"log/slog"
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

// ProviderEditor is what the model endpoints of an agent need beyond the
// snapshot (providers.Service); the routes exist only when the source has them.
type ProviderEditor interface {
	RefreshModels(ctx context.Context, id string) (providers.Provider, error)
	SetCustomModels(id string, names []string) (providers.Provider, error)
	SetPrefs(id string, preferred *string, roles map[string]string) (providers.Provider, error)
	Recheck(ctx context.Context, id string) (providers.Provider, error)
}

func (s *Server) providerError(w http.ResponseWriter, err error) {
	var nr *providers.NotReadyError
	var ve *providers.ValidationError
	switch {
	case errors.Is(err, providers.ErrUnknownAgent):
		writeError(w, http.StatusNotFound, "not_found", "no such agent")
	case errors.Is(err, providers.ErrDiscoveryOff):
		writeError(w, http.StatusConflict, "discovery_off", "model discovery is switched off (HARNESS_MODEL_DISCOVERY=0)")
	case errors.As(err, &nr):
		writeError(w, http.StatusConflict, "not_ready", nr.Reason)
	case errors.As(err, &ve):
		writeError(w, http.StatusBadRequest, "invalid_request", ve.Message)
	default:
		slog.Error("provider request failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "internal error")
	}
}

// POST /v1/providers/{id}/refresh-models: look for the agent's models now.
func (s *Server) refreshProviderModels(w http.ResponseWriter, r *http.Request) {
	p, err := s.providers.(ProviderEditor).RefreshModels(r.Context(), r.PathValue("id"))
	if err != nil {
		s.providerError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// PUT /v1/providers/{id}/custom-models {"models": [...]}: replace the names typed for the agent.
func (s *Server) putCustomModels(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Models []string `json:"models"`
	}
	if !decode(w, r, &in) {
		return
	}
	p, err := s.providers.(ProviderEditor).SetCustomModels(r.PathValue("id"), in.Models)
	if err != nil {
		s.providerError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// PUT /v1/providers/{id}/prefs {"preferred_model"?: string, "roles"?: {fast?, balanced?, deep?}}.
func (s *Server) putProviderPrefs(w http.ResponseWriter, r *http.Request) {
	var in struct {
		PreferredModel *string           `json:"preferred_model"`
		Roles          map[string]string `json:"roles"`
	}
	if !decode(w, r, &in) {
		return
	}
	p, err := s.providers.(ProviderEditor).SetPrefs(r.PathValue("id"), in.PreferredModel, in.Roles)
	if err != nil {
		s.providerError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// POST /v1/providers/{id}/recheck: run the agent's login probe now ("I've
// logged in: check again") and answer the provider entry.
func (s *Server) recheckProvider(w http.ResponseWriter, r *http.Request) {
	p, err := s.providers.(ProviderEditor).Recheck(r.Context(), r.PathValue("id"))
	if err != nil {
		s.providerError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}
