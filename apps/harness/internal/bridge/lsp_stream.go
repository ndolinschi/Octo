package bridge

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/lsp"
)

func (s *Server) postLSPMessage(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.lspSession(w, r)
	if !ok {
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, lsp.MaxMessageSize))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeLSPErr(w, lsp.ErrTooLarge)
			return
		}
		writeError(w, http.StatusBadRequest, "invalid_request", "cannot read body: "+err.Error())
		return
	}
	if err := sess.Send(r.Context(), body); err != nil {
		writeLSPErr(w, err)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (s *Server) deleteLSPSession(w http.ResponseWriter, r *http.Request) {
	if s.lsp == nil {
		writeLSPErr(w, lsp.ErrNotFound)
		return
	}
	if err := s.lsp.Close(r.PathValue("pid"), r.PathValue("sid")); err != nil {
		writeLSPErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) lspEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "internal", "streaming unsupported")
		return
	}
	sess, ok := s.lspSession(w, r)
	if !ok {
		return
	}
	ch, release, err := sess.Subscribe()
	if err != nil {
		writeLSPErr(w, err)
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
		case data, open := <-ch:
			if !open {
				s.lspExit(w, r, sess)
				flusher.Flush()
				return
			}
			if _, err := fmt.Fprintf(w, "event: message\ndata: %s\n\n", data); err != nil {
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

// lspExit sends the final exit event and unregisters the ended session.
func (s *Server) lspExit(w http.ResponseWriter, r *http.Request, sess *lsp.Session) {
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
		slog.Error("encode lsp exit", "err", err)
		return
	}
	if _, err := fmt.Fprintf(w, "event: exit\ndata: %s\n\n", data); err != nil {
		return
	}
	sess.Close(info.Reason)
}

func (s *Server) lspSession(w http.ResponseWriter, r *http.Request) (*lsp.Session, bool) {
	if s.lsp == nil {
		writeLSPErr(w, lsp.ErrNotFound)
		return nil, false
	}
	sess, err := s.lsp.Get(r.PathValue("pid"), r.PathValue("sid"))
	if err != nil {
		writeLSPErr(w, err)
		return nil, false
	}
	return sess, true
}

func writeLSPErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, lsp.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "language server session not found")
	case errors.Is(err, lsp.ErrClosed):
		writeError(w, http.StatusNotFound, "session_closed", "language server session has ended")
	case errors.Is(err, lsp.ErrTooManySessions):
		writeError(w, http.StatusTooManyRequests, "too_many_sessions", "too many language server sessions for this project")
	case errors.Is(err, lsp.ErrTooLarge):
		writeError(w, http.StatusRequestEntityTooLarge, "message_too_large", "message exceeds the 4 MiB limit")
	case errors.Is(err, lsp.ErrInvalidMessage):
		writeError(w, http.StatusBadRequest, "invalid_request", "body must be one JSON-RPC message (a JSON object)")
	case errors.Is(err, lsp.ErrSubscribed):
		writeError(w, http.StatusConflict, "already_subscribed", "session already has an event stream")
	case errors.Is(err, lsp.ErrShutdown):
		writeError(w, http.StatusServiceUnavailable, "shutting_down", "harness is shutting down")
	default:
		slog.Error("language server request failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "could not start language server")
	}
}
