package mockllm

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func headersFor(t *testing.T, h http.Handler, stream bool) http.Header {
	t.Helper()
	body := `{"model":"m","messages":[{"role":"user","content":"hi"}]}`
	if stream {
		body = `{"model":"m","stream":true,"messages":[{"role":"user","content":"hi"}]}`
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(body)))
	return rec.Header()
}

func TestRateLimitHeaders(t *testing.T) {
	tests := []struct {
		name      string
		opts      []Option
		present   []string
		absent    []string
		resetKind string
	}{
		{"default is anthropic", nil,
			[]string{"anthropic-ratelimit-requests-limit", "anthropic-ratelimit-requests-remaining", "anthropic-ratelimit-tokens-reset", "anthropic-ratelimit-input-tokens-remaining"},
			[]string{"x-ratelimit-limit-requests"}, "rfc3339"},
		{"openai style", []Option{WithRateLimitStyle(StyleOpenAI)},
			[]string{"x-ratelimit-limit-requests", "x-ratelimit-remaining-tokens", "x-ratelimit-reset-requests"},
			[]string{"anthropic-ratelimit-requests-limit"}, "duration"},
		{"none", []Option{WithRateLimitStyle(StyleNone)}, nil,
			[]string{"anthropic-ratelimit-requests-limit", "x-ratelimit-limit-requests"}, ""},
	}
	for _, tc := range tests {
		for _, stream := range []bool{false, true} {
			t.Run(tc.name, func(t *testing.T) {
				h := headersFor(t, New(0, tc.opts...), stream)
				for _, k := range tc.present {
					if h.Get(k) == "" {
						t.Errorf("missing header %s (stream=%v)", k, stream)
					}
				}
				for _, k := range tc.absent {
					if h.Get(k) != "" {
						t.Errorf("unexpected header %s", k)
					}
				}
				switch tc.resetKind {
				case "rfc3339":
					if _, err := time.Parse(time.RFC3339, h.Get("anthropic-ratelimit-tokens-reset")); err != nil {
						t.Errorf("reset is not RFC 3339: %v", err)
					}
				case "duration":
					if _, err := time.ParseDuration(h.Get("x-ratelimit-reset-tokens")); err != nil {
						t.Errorf("reset is not a duration: %v", err)
					}
				}
			})
		}
	}
}

func TestRemainingDropsPerRequest(t *testing.T) {
	h := New(0)
	first := headersFor(t, h, false).Get("anthropic-ratelimit-requests-remaining")
	second := headersFor(t, h, false).Get("anthropic-ratelimit-requests-remaining")
	if first == second || first == "" {
		t.Fatalf("remaining %q then %q, want a drop", first, second)
	}
}
