package bridge

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/settings"
)

// SettingsStore is what GET and PUT /v1/settings serve (settings.Manager).
type SettingsStore interface {
	Get() (settings.View, error)
	Put(settings.Update) (settings.View, error)
}

// WithSettings serves /v1/settings. loopbackBind says the server listens on a
// loopback address only; with a remote bind the endpoints answer 403, because
// they write provider keys.
func WithSettings(store SettingsStore, loopbackBind bool) Option {
	return func(s *Server) { s.settings, s.settingsLoopback = store, loopbackBind }
}

// WithLoopbackBind says the server listens on a loopback address only, which
// the folder endpoints (/v1/fs/*) require. WithSettings sets it too.
func WithLoopbackBind(loopbackBind bool) Option {
	return func(s *Server) { s.settingsLoopback = loopbackBind }
}

// settingsGuard enforces the rules of the settings endpoints: a loopback bind,
// a loopback peer, a loopback Host (against DNS rebinding) and, when the
// request carries an Origin, one the bridge allows. It writes the 403 itself.
func (s *Server) settingsGuard(w http.ResponseWriter, r *http.Request) bool {
	return s.loopbackGuard(w, r, "settings")
}

// loopbackGuard is settingsGuard for any endpoint family; what names it in the 403.
func (s *Server) loopbackGuard(w http.ResponseWriter, r *http.Request, what string) bool {
	deny := func(msg string) bool {
		writeError(w, http.StatusForbidden, "forbidden", msg)
		return false
	}
	switch {
	case !s.settingsLoopback:
		return deny(what + " are available only when the bridge listens on a loopback address")
	case !loopbackPeer(r.RemoteAddr):
		return deny(what + " are available to loopback clients only")
	case !loopbackHost(r.Host):
		return deny(what + " are available only through a loopback host name")
	}
	if o := r.Header.Get("Origin"); o != "" && !s.originAllowed(o) {
		return deny("origin not allowed")
	}
	return true
}

func (s *Server) getSettings(w http.ResponseWriter, r *http.Request) {
	if !s.settingsGuard(w, r) {
		return
	}
	v, err := s.settings.Get()
	s.writeSettings(w, v, err)
}

func (s *Server) putSettings(w http.ResponseWriter, r *http.Request) {
	if !s.settingsGuard(w, r) {
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "cannot read the request body")
		return
	}
	var u settings.Update
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	// The messages below are fixed text: a decoder error can quote a byte of
	// the value, and a value may be a secret.
	if err := dec.Decode(&u); err != nil || dec.More() {
		writeError(w, http.StatusBadRequest, "invalid_request", `the body must be a JSON object like {"set": {id: value}, "unset": [id]}`)
		return
	}
	v, err := s.settings.Put(u)
	s.writeSettings(w, v, err)
}

func (s *Server) writeSettings(w http.ResponseWriter, v settings.View, err error) {
	var se *settings.Error
	switch {
	case errors.As(err, &se):
		writeError(w, http.StatusBadRequest, se.Code, se.Message)
	case err != nil:
		// The text may name a path, never a value.
		slog.Error("settings request failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "the settings file could not be read or written")
	default:
		writeJSON(w, http.StatusOK, v)
	}
}

func loopbackPeer(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// loopbackHost accepts localhost, 127.0.0.0/8 and ::1 with an optional port.
func loopbackHost(hostport string) bool {
	host := hostport
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		host = h
	}
	host = strings.Trim(host, "[]")
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
