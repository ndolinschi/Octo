package bridge

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/terminal"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

func (s *Server) postTerminalInput(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.terminalSession(w, r)
	if !ok {
		return
	}
	var in struct {
		Data string `json:"data"`
	}
	if !decode(w, r, &in) {
		return
	}
	if err := sess.WriteInput(r.Context(), []byte(in.Data)); err != nil {
		writeTerminalErr(w, err)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (s *Server) resizeTerminalSession(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.terminalSession(w, r)
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
	if err := sess.Resize(in.Cols, in.Rows); err != nil {
		writeTerminalErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) deleteTerminalSession(w http.ResponseWriter, r *http.Request) {
	if s.terminals == nil {
		writeTerminalErr(w, terminal.ErrNotFound)
		return
	}
	if err := s.terminals.Close(r.PathValue("pid"), r.PathValue("tid")); err != nil {
		writeTerminalErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) terminalEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeProblem(w, http.StatusInternalServerError, usererr.Generic("internal", "streaming unsupported"))
		return
	}
	sess, ok := s.terminalSession(w, r)
	if !ok {
		return
	}
	ch, release, err := sess.Subscribe()
	if err != nil {
		writeTerminalErr(w, err)
		return
	}
	defer release()

	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
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
		case chunk, open := <-ch:
			if !open {
				s.terminalExit(w, r, sess)
				flusher.Flush()
				return
			}
			payload, err := json.Marshal(map[string]string{
				"data": base64.StdEncoding.EncodeToString(chunk),
			})
			if err != nil {
				return
			}
			if _, err := fmt.Fprintf(w, "event: output\ndata: %s\n\n", payload); err != nil {
				return
			}
			flusher.Flush()
		case <-ticker.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (s *Server) terminalExit(w http.ResponseWriter, r *http.Request, sess *terminal.Session) {
	info, err := sess.Exit(r.Context())
	if err != nil {
		return
	}
	payload := map[string]any{"code": info.Code}
	if info.Reason != "" {
		payload["reason"] = info.Reason
	}
	data, err := json.Marshal(payload)
	if err != nil {
		slog.Error("encode terminal exit", "err", err)
		return
	}
	if _, err := fmt.Fprintf(w, "event: exit\ndata: %s\n\n", data); err != nil {
		return
	}
	sess.Close(info.Reason)
}

func (s *Server) terminalSession(w http.ResponseWriter, r *http.Request) (*terminal.Session, bool) {
	if s.terminals == nil {
		writeTerminalErr(w, terminal.ErrNotFound)
		return nil, false
	}
	sess, err := s.terminals.Get(r.PathValue("pid"), r.PathValue("tid"))
	if err != nil {
		writeTerminalErr(w, err)
		return nil, false
	}
	return sess, true
}

func writeTerminalErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, terminal.ErrNotFound):
		writeProblem(w, http.StatusNotFound, usererr.NotFoundWhat("terminal"))
	case errors.Is(err, terminal.ErrClosed):
		writeProblem(w, http.StatusNotFound, usererr.Generic("terminal_closed", "terminal session has ended"))
	case errors.Is(err, terminal.ErrTooManySessions):
		writeProblem(w, http.StatusTooManyRequests, usererr.Generic("too_many_terminals", "too many terminal sessions for this project"))
	case errors.Is(err, terminal.ErrTooLarge):
		writeProblem(w, http.StatusRequestEntityTooLarge, usererr.RequestTooLarge(64<<10))
	case errors.Is(err, terminal.ErrInvalidDimensions):
		writeProblem(w, http.StatusBadRequest, usererr.Generic("invalid_request", "terminal cols and rows must be positive and within limits"))
	case errors.Is(err, terminal.ErrSubscribed):
		writeProblem(w, http.StatusConflict, usererr.Generic("terminal_already_subscribed", "terminal session already has an active event stream"))
	case errors.Is(err, terminal.ErrShutdown):
		writeProblem(w, http.StatusServiceUnavailable, usererr.Generic("shutting_down", "harness is shutting down"))
	default:
		slog.Error("terminal request failed", "err", err)
		writeProblem(w, http.StatusInternalServerError, usererr.Unexpected(err))
	}
}
