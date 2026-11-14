package mockllm

import (
	"net/http"
	"strconv"
	"sync/atomic"
	"time"
)

// RateLimitStyle selects which rate-limit response headers the mock sends.
type RateLimitStyle string

const (
	// StyleAnthropic sends anthropic-ratelimit-* headers with RFC 3339 resets (the default).
	StyleAnthropic RateLimitStyle = "anthropic"
	// StyleOpenAI sends x-ratelimit-* headers with duration resets ("1s", "6m0s").
	StyleOpenAI RateLimitStyle = "openai"
	// StyleNone sends no rate-limit headers.
	StyleNone RateLimitStyle = "none"
)

// Valid reports whether s is a known style.
func (s RateLimitStyle) Valid() bool {
	return s == StyleAnthropic || s == StyleOpenAI || s == StyleNone
}

// Option customizes New.
type Option func(*server)

// WithRateLimitStyle picks the rate-limit headers; StyleAnthropic by default.
func WithRateLimitStyle(s RateLimitStyle) Option { return func(m *server) { m.style = s } }

type server struct {
	style RateLimitStyle
	reqs  atomic.Int64
	now   func() time.Time
	cache *cacheStore
	holds *Holds
}

type quota struct {
	kind  string // "requests", "tokens", "input-tokens", "output-tokens"
	limit int64
	reset time.Duration
}

var anthropicQuotas = []quota{
	{"requests", 50, time.Minute},
	{"tokens", 40000, time.Minute},
	{"input-tokens", 30000, time.Minute},
	{"output-tokens", 10000, time.Minute},
}

var openAIQuotas = []quota{
	{"requests", 60, time.Second},
	{"tokens", 150000, 6 * time.Minute},
}

// setRateLimits adds headers whose remaining counts drop with every request.
func (m *server) setRateLimits(h http.Header) {
	n := m.reqs.Add(1)
	now := m.now()
	switch m.style {
	case StyleAnthropic:
		for _, q := range anthropicQuotas {
			p := "anthropic-ratelimit-" + q.kind
			h.Set(p+"-limit", strconv.FormatInt(q.limit, 10))
			h.Set(p+"-remaining", strconv.FormatInt(remaining(q, n), 10))
			h.Set(p+"-reset", now.Add(q.reset).UTC().Format(time.RFC3339))
		}
	case StyleOpenAI:
		for _, q := range openAIQuotas {
			h.Set("x-ratelimit-limit-"+q.kind, strconv.FormatInt(q.limit, 10))
			h.Set("x-ratelimit-remaining-"+q.kind, strconv.FormatInt(remaining(q, n), 10))
			h.Set("x-ratelimit-reset-"+q.kind, q.reset.String())
		}
	}
}

func remaining(q quota, n int64) int64 {
	step := int64(1)
	if q.kind != "requests" {
		step = q.limit / 100
	}
	return max(q.limit-n*step, 0)
}
