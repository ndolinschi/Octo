package mockllm

import (
	"encoding/json"
	"io"
	"net/http"
	"time"
)

func jsonUnmarshal(raw json.RawMessage, v any) error { return json.Unmarshal(raw, v) }

// New returns a deterministic Anthropic-compatible Messages server. delay is
// the pause between streamed chunks.
func New(delay time.Duration, opts ...Option) http.Handler {
	m := &server{style: StyleAnthropic, now: time.Now, cache: &cacheStore{}}
	for _, o := range opts {
		o(m)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/messages", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 16<<20))
		var req request
		if err == nil {
			err = json.Unmarshal(body, &req)
		}
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request_error", err.Error())
			return
		}
		rep := plan(&req)
		u := usage(&req, rep)
		u.CacheRead, u.CacheWrite, u.Input = m.cache.account(body, u.Input)
		m.setRateLimits(w.Header())
		if req.Stream {
			streamReply(w, r, &req, rep, u, delay)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(fullMessage(&req, rep, u)); err != nil {
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
