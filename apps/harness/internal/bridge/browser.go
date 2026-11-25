package bridge

import (
	"context"
	"errors"
	"net/http"

	"github.com/ndolinschi/Octo/apps/harness/internal/browserproxy"
)

// BrowserProxy opens and closes ephemeral loopback proxy listeners for the UI's Browser tab.
type BrowserProxy interface {
	Open(ctx context.Context, projectID, rawURL string) (browserproxy.Session, error)
	CloseProject(ctx context.Context, projectID string) error
}

// WithBrowserProxy attaches a BrowserProxy manager to serve /v1/projects/{pid}/browser/proxy.
func WithBrowserProxy(bp BrowserProxy) Option {
	return func(s *Server) { s.browser = bp }
}

func (s *Server) browserRoutes(mux *http.ServeMux) {
	if s.browser == nil {
		return
	}
	mux.HandleFunc("POST /v1/projects/{pid}/browser/proxy", s.openBrowserProxy)
	mux.HandleFunc("DELETE /v1/projects/{pid}/browser/proxy", s.closeBrowserProxy)
}

func (s *Server) openBrowserProxy(w http.ResponseWriter, r *http.Request) {
	pid := r.PathValue("pid")
	if _, err := s.svc.Get(r.Context(), pid); err != nil {
		writeErr(w, err)
		return
	}
	var in struct {
		URL string `json:"url"`
	}
	if !decode(w, r, &in) {
		return
	}
	sess, err := s.browser.Open(r.Context(), pid, in.URL)
	if err != nil {
		var be *browserproxy.Error
		if errors.As(err, &be) {
			status := http.StatusBadRequest
			if be.Kind == browserproxy.KindForbidden {
				status = http.StatusForbidden
			}
			writeError(w, status, be.Code, be.Message)
			return
		}
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, sess)
}

func (s *Server) closeBrowserProxy(w http.ResponseWriter, r *http.Request) {
	pid := r.PathValue("pid")
	if _, err := s.svc.Get(r.Context(), pid); err != nil {
		writeErr(w, err)
		return
	}
	if err := s.browser.CloseProject(r.Context(), pid); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
