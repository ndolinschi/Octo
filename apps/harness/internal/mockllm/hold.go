package mockllm

import (
	"context"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The [hold] marker keeps a reply open until a test releases it, so two turns can be in flight at once (parallel
// sessions). A request whose last user text holds "[hold]" or "[hold:NAME]" (and that has no answer of the
// model after it yet) is answered with a short text; when streamed, its first words are sent, then the reply
// waits for Release(NAME) ("" for a bare [hold]), POST /v1/mock/release?name=NAME, the client going away, or
// HoldTimeout. A release opens the gate for good: later requests with that name pass straight through.
var holdRe = regexp.MustCompile(`\[hold(?::([A-Za-z0-9_-]+))?\]`)

// HoldTimeout is the longest a held reply waits (a test that forgets to release does not hang for ever).
var HoldTimeout = 2 * time.Minute

// Holds are the gates of held replies.
type Holds struct {
	mu      sync.Mutex
	gates   map[string]chan struct{}
	waiting map[string]int
}

// NewHolds makes an empty set of gates.
func NewHolds() *Holds { return &Holds{gates: map[string]chan struct{}{}, waiting: map[string]int{}} }

// WithHolds lets a test hold and release replies itself.
func WithHolds(h *Holds) Option { return func(m *server) { m.holds = h } }

func (h *Holds) gate(name string) chan struct{} {
	h.mu.Lock()
	defer h.mu.Unlock()
	g := h.gates[name]
	if g == nil {
		g = make(chan struct{})
		h.gates[name] = g
	}
	return g
}

// Release lets every reply held under name go on, now and later.
func (h *Holds) Release(name string) {
	g := h.gate(name)
	h.mu.Lock()
	defer h.mu.Unlock()
	select {
	case <-g:
	default:
		close(g)
	}
}

// Waiting is how many replies wait under name now.
func (h *Holds) Waiting(name string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.waiting[name]
}

// wait blocks until name is released or ctx ends.
func (h *Holds) wait(ctx context.Context, name string) bool {
	g := h.gate(name)
	h.mu.Lock()
	h.waiting[name]++
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		h.waiting[name]--
		h.mu.Unlock()
	}()
	ctx, cancel := context.WithTimeout(ctx, HoldTimeout)
	defer cancel()
	select {
	case <-g:
		return true
	case <-ctx.Done():
		return false
	}
}

// holdName says whether the request is held and under which name.
func holdName(r *request) (string, bool) {
	anchor := r.lastUserTextIndex()
	// Only an agent's turn is held (it offers tools); a summary, digest or side call that quotes the text is not.
	if anchor < 0 || r.assistantCountFrom(anchor) > 0 || len(r.Tools) == 0 || strings.Contains(r.system(), digestMarker) {
		return "", false
	}
	m := holdRe.FindStringSubmatch(r.Messages[anchor].text())
	if m == nil {
		return "", false
	}
	return m[1], true
}

func (m *server) holdRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/mock/release", func(w http.ResponseWriter, r *http.Request) {
		m.holds.Release(r.URL.Query().Get("name"))
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("GET /v1/mock/held", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(strconv.Itoa(m.holds.Waiting(r.URL.Query().Get("name")))))
	})
}
