package mockllm

import (
	"encoding/json"
	"net/http"
	"time"
)

func jsonUnmarshal(raw json.RawMessage, v any) error { return json.Unmarshal(raw, v) }

// New returns a deterministic Anthropic-compatible Messages server. delay is
// the pause between streamed chunks.
func New(delay time.Duration, opts ...Option) http.Handler {
	m := &server{style: StyleAnthropic, now: time.Now}
	for _, o := range opts {
		o(m)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/messages", func(w http.ResponseWriter, r *http.Request) {
		var req request
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<20)).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request_error", err.Error())
			return
		}
		rep := plan(&req)
		m.setRateLimits(w.Header())
		if req.Stream {
			streamReply(w, r, &req, rep, delay)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(fullMessage(&req, rep)); err != nil {
			return
		}
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not_found_error", "not found")
	})
	return mux
}

func writeError(w http.ResponseWriter, status int, typ, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(map[string]any{
		"type": "error", "error": map[string]string{"type": typ, "message": msg},
	}); err != nil {
		return
	}
}
