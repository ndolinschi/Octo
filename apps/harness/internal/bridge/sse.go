package bridge

import (
	"fmt"
	"net/http"
	"time"
)

func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "internal", "streaming unsupported")
		return
	}
	ch, cancel, err := s.svc.Subscribe(r.Context(), r.PathValue("pid"))
	if err != nil {
		writeErr(w, err)
		return
	}
	defer cancel()

	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	// `retry`: after a dropped connection (the harness restarted) EventSource tries again in 1 s instead of its 3 s default.
	if _, err := fmt.Fprint(w, "retry: 1000\n: connected\n\n"); err != nil {
		return
	}
	flusher.Flush()

	ticker := time.NewTicker(s.ping)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case ev, open := <-ch:
			if !open {
				return
			}
			if _, err := fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", ev.Seq, ev.Type, ev.Data); err != nil {
				return
			}
			flusher.Flush()
		case <-ticker.C:
			// A named event, not a comment: EventSource hides comments from the page, and the UI treats a
			// stream that has been silent for several intervals as dead (half-open) and reopens it. No `id:`,
			// so the last event id stays the last real event's seq.
			if _, err := fmt.Fprint(w, "event: heartbeat\ndata: {}\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
