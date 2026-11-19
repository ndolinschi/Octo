// Package router is the harness side of the Octo router integration: it
// detects an Octo router behind --base-url, builds the request hint headers,
// reads the result headers and the per-call record, and remembers the last
// known spend per budget key. Everything is nil-safe: a nil *Router is a base
// URL that is not an Octo router.
package router

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"slices"
	"sync"
	"time"
)

// Capability names announced by the router's GET /health.
const (
	CapAutoroute     = "autoroute"
	CapRouteHints    = "route_hints"
	CapResultHeaders = "result_headers"
	CapBudgetKey     = "budget_key"
)

const (
	probeTimeout  = 2 * time.Second
	reprobeEvery  = time.Minute
	callRetryWait = 200 * time.Millisecond
)

// Option customizes New.
type Option func(*Router)

// WithHTTPClient replaces the client used for health probes and call records.
func WithHTTPClient(c *http.Client) Option { return func(r *Router) { r.http = c } }

// WithReprobeInterval overrides how long to wait before probing again after a
// failed probe.
func WithReprobeInterval(d time.Duration) Option { return func(r *Router) { r.reprobe = d } }

// WithCallRetryWait overrides the pause before the single call-record retry.
func WithCallRetryWait(d time.Duration) Option { return func(r *Router) { r.retryWait = d } }

// Router is the detected integration state for one base URL.
type Router struct {
	origin       string
	octoKey      string
	apiKey       string
	apiKeyFn     func() string
	http         *http.Client
	reprobe      time.Duration
	retryWait    time.Duration
	routeTimeout time.Duration
	life         context.Context
	now          func() time.Time

	mu        sync.Mutex
	on        bool
	caps      []string
	version   string
	nextProbe time.Time
	probing   bool
	spent     map[string]float64
}

// New probes baseURL's origin once, synchronously and with a short timeout.
// When the probe fails (or the base URL is empty) the router stays off and is
// probed again lazily, off the request path, at most once a minute until it
// answers; ctx bounds those background probes.
func New(ctx context.Context, baseURL, octoKey string, opts ...Option) *Router {
	r := &Router{
		octoKey: octoKey, http: &http.Client{}, reprobe: reprobeEvery, retryWait: callRetryWait, routeTimeout: DefaultRouteTimeout,
		life: ctx, now: time.Now, spent: map[string]float64{},
	}
	for _, o := range opts {
		o(r)
	}
	if u, err := url.Parse(baseURL); err == nil && u.Scheme != "" && u.Host != "" {
		r.origin = u.Scheme + "://" + u.Host
	}
	if r.origin == "" {
		return r
	}
	r.runProbe()
	return r
}

type healthBody struct {
	Service      string   `json:"service"`
	Version      string   `json:"version"`
	Capabilities []string `json:"capabilities"`
}

// runProbe performs one health probe and records the outcome.
func (r *Router) runProbe() {
	on, caps, version := r.probe()
	r.mu.Lock()
	defer r.mu.Unlock()
	r.probing = false
	r.on, r.caps, r.version = on, caps, version
	r.nextProbe = r.now().Add(r.reprobe)
}

func (r *Router) probe() (bool, []string, string) {
	ctx, cancel := context.WithTimeout(r.life, probeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.origin+"/health", nil)
	if err != nil {
		return false, nil, ""
	}
	resp, err := r.http.Do(req)
	if err != nil {
		return false, nil, ""
	}
	defer resp.Body.Close()
	var h healthBody
	if resp.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&h) != nil {
		return false, nil, ""
	}
	if h.Service != "octo" {
		return false, nil, ""
	}
	return true, h.Capabilities, h.Version
}

// Enabled reports whether an Octo router was detected. While it is off and the
// last probe is over a minute old, it starts one background re-probe.
func (r *Router) Enabled() bool {
	if r == nil || r.origin == "" {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.on && !r.probing && !r.now().Before(r.nextProbe) && r.life.Err() == nil {
		r.probing = true
		go r.runProbe()
	}
	return r.on
}

// Capabilities returns the announced capability names (empty when off).
func (r *Router) Capabilities() []string {
	if r == nil {
		return []string{}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string{}, r.caps...)
}

// Version is the version the detected router announced ("" when none is detected).
func (r *Router) Version() string {
	if r == nil {
		return ""
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.on {
		return ""
	}
	return r.version
}

// Has reports whether the router announced capability c.
func (r *Router) Has(c string) bool {
	return r.Enabled() && slices.Contains(r.Capabilities(), c)
}

// Spent returns the last spend the router reported for a budget key.
func (r *Router) Spent(key string) (float64, bool) {
	if r == nil {
		return 0, false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	v, ok := r.spent[key]
	return v, ok
}

// NoteSpent records router-reported spend for a budget key. The highest value
// seen wins: the router's figure only grows, and two calls that run at once
// can finish in either order, so the later arrival is not the newer figure.
func (r *Router) NoteSpent(key string, usd float64) {
	if r == nil || key == "" {
		return
	}
	r.mu.Lock()
	if v, ok := r.spent[key]; !ok || usd > v {
		r.spent[key] = usd
	}
	r.mu.Unlock()
}
