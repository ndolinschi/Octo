package bridge

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/agentlogin"
	"github.com/ndolinschi/Octo/apps/harness/internal/providers"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// loginFinalWait bounds how long an event stream waits, after the process
// exited, for the last login check.
const loginFinalWait = 30 * time.Second

// AgentLogins runs an agent's login command in a PTY (agentlogin.Service).
type AgentLogins interface {
	Start(ctx context.Context, agentID string, req agentlogin.Request) (*agentlogin.Login, error)
	Get(agentID, id string) (*agentlogin.Login, error)
	Close(agentID, id string) error
}

// WithAgentLogins enables the login routes of /v1/providers/{id}/login.
func WithAgentLogins(l AgentLogins) Option { return func(s *Server) { s.logins = l } }

func (s *Server) agentLoginRoutes(mux *http.ServeMux) {
	if s.logins == nil {
		return
	}
	mux.HandleFunc("POST /v1/providers/{id}/login", s.startLogin)
	mux.HandleFunc("GET /v1/providers/{id}/login/{lid}/events", s.loginEvents)
	mux.HandleFunc("POST /v1/providers/{id}/login/{lid}/input", s.loginInput)
	mux.HandleFunc("POST /v1/providers/{id}/login/{lid}/resize", s.loginResize)
	mux.HandleFunc("DELETE /v1/providers/{id}/login/{lid}", s.deleteLogin)
}

// POST /v1/providers/{id}/login {"method"?, "cols"?, "rows"?}.
func (s *Server) startLogin(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Method string `json:"method"`
		Cols   int    `json:"cols"`
		Rows   int    `json:"rows"`
	}
	if r.ContentLength != 0 && !decode(w, r, &in) {
		return
	}
	l, err := s.logins.Start(r.Context(), r.PathValue("id"), agentlogin.Request{Method: in.Method, Cols: in.Cols, Rows: in.Rows})
	if err != nil {
		writeLoginErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"session_id": l.ID, "command": l.Command, "pid": l.Session().PID()})
}

func (s *Server) loginInput(w http.ResponseWriter, r *http.Request) {
	l, ok := s.login(w, r)
	if !ok {
		return
	}
	var in struct {
		Data string `json:"data"`
	}
	if !decode(w, r, &in) {
		return
	}
	if err := l.Session().WriteInput(r.Context(), []byte(in.Data)); err != nil {
		writeTerminalErr(w, err)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (s *Server) loginResize(w http.ResponseWriter, r *http.Request) {
	l, ok := s.login(w, r)
	if !ok {
		return
	}
	var in struct {
		Cols int `json:"cols"`
		Rows int `json:"rows"`
	}
	if !decode(w, r, &in) {
		return
	}
	if err := l.Session().Resize(in.Cols, in.Rows); err != nil {
		writeTerminalErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) deleteLogin(w http.ResponseWriter, r *http.Request) {
	if err := s.logins.Close(r.PathValue("id"), r.PathValue("lid")); err != nil {
		writeLoginErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) (*agentlogin.Login, bool) {
	l, err := s.logins.Get(r.PathValue("id"), r.PathValue("lid"))
	if err != nil {
		writeLoginErr(w, err)
		return nil, false
	}
	return l, true
}

func writeLoginErr(w http.ResponseWriter, err error) {
	var un *agentlogin.UnavailableError
	var ni *agentlogin.NotInstalledError
	switch {
	case errors.As(err, &ni):
		writeProblem(w, http.StatusConflict, providers.AgentMissing(ni.Agent))
	case errors.As(err, &un):
		writeProblem(w, http.StatusConflict, usererr.LoginUnavailable(un.Label, un.Command, un.Reason))
	case errors.Is(err, agentlogin.ErrNotFound):
		writeProblem(w, http.StatusNotFound, usererr.NotFoundWhat("login"))
	default:
		writeTerminalErr(w, err)
	}
}

// GET /v1/providers/{id}/login/{lid}/events: the terminal's `output` and `exit`
// frames, and `login` {state} for each check of the agent's login.
func (s *Server) loginEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeProblem(w, http.StatusInternalServerError, usererr.Unexpected(errors.New("streaming unsupported")))
		return
	}
	l, ok := s.login(w, r)
	if !ok {
		return
	}
	out, release, err := l.Session().Subscribe()
	if err != nil {
		writeTerminalErr(w, err)
		return
	}
	defer release()
	states, unwatch := l.Watch()
	defer unwatch()

	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	send := func(event string, v any) bool {
		data, err := json.Marshal(v)
		if err != nil {
			slog.Error("encode login event", "event", event, "err", err)
			return false
		}
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	if _, err := fmt.Fprint(w, ": connected\n\n"); err != nil {
		return
	}
	flusher.Flush()

	ticker := time.NewTicker(s.ping)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case chunk, open := <-out:
			if !open {
				s.loginFinish(r.Context(), l, states, send)
				return
			}
			if !send("output", map[string]string{"data": base64.StdEncoding.EncodeToString(chunk)}) {
				return
			}
		case st := <-states:
			if !send("login", map[string]string{"state": st}) {
				return
			}
		case <-ticker.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// loginFinish sends `exit`, then the checks still to come (the last one runs
// after the process exited), and closes the session.
func (s *Server) loginFinish(ctx context.Context, l *agentlogin.Login, states <-chan string, send func(string, any) bool) {
	info, err := l.Session().Exit(ctx)
	if err != nil {
		return
	}
	payload := map[string]any{"code": info.Code}
	if info.Reason != "" {
		payload["reason"] = info.Reason
	}
	if !send("exit", payload) {
		return
	}
	wait := time.NewTimer(loginFinalWait)
	defer wait.Stop()
	for {
		select {
		case st := <-states:
			if !send("login", map[string]string{"state": st}) {
				return
			}
		case <-l.Done():
			for {
				select {
				case st := <-states:
					if !send("login", map[string]string{"state": st}) {
						return
					}
				default:
					l.Session().Close(info.Reason)
					return
				}
			}
		case <-wait.C:
			return
		case <-ctx.Done():
			return
		}
	}
}
