// Package fakerouter is a stand-in for an Octo router in tests: it implements
// the I1 contract (GET /health capabilities, result headers on the Messages
// endpoint, a per-request call record that is 404 until ready, budget keys with
// a 402 reject, and a one-shot compaction) in front of any upstream handler.
// Its routing rules are deliberately naive; they only make the contract
// observable, they do not model the real router.
package fakerouter

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
)

// Ladder maps router tiers to the slugs the fake serves.
var Ladder = map[string]string{"low": "ladder-low", "mid": "ladder-mid", "high": "ladder-high"}

var hintTier = map[string]string{"fast": "low", "balanced": "mid", "deep": "high"}

var tierRank = map[string]int{"low": 0, "mid": 1, "high": 2}

// Options configures a fake router. The zero value serves all four capabilities
// with call records that are ready at once.
type Options struct {
	// Capabilities announced by /health; nil means all four.
	Capabilities []string
	// Rates is USD per million input and output tokens per served tier; the
	// default is 3 and 15 for every tier.
	Rates map[string][2]float64
	// CompactAt makes the router answer with a compaction summary instead of a
	// reply the first time a session sends this many messages or more (0: never).
	CompactAt int
	// NotReady is how many times a call record answers 404 before it is ready
	// (zero: ready at once).
	NotReady int
	// NoRecords makes every call record 404 forever.
	NoRecords bool
	// Unpriced makes every call record read cost_usd 0 with cost_source
	// "estimated", as the real router does when it knows no price.
	Unpriced bool
	// CompactAsText makes a compaction carry its summary in a plain text block
	// instead of a "compaction" block.
	CompactAsText bool
	// RejectRole answers every request of this agent role ("sub") with the
	// budget 402, whatever the spend.
	RejectRole string
	// IgnoreBudget makes the fake accept requests over budget (the harness's own
	// checks are then the only ones in play).
	IgnoreBudget bool
	// CostSource is the call record's cost_source (default "reported").
	CostSource string
	// Route scripts the I2 route endpoint (POST /autoroute/v1/route). When set
	// and Capabilities is nil, route_api is announced too.
	Route *RouteScript
}

// Request is what the fake saw and decided for one Messages request.
type Request struct {
	Header  http.Header
	Body    []byte
	Status  int
	ID      string
	Served  string
	Tier    string
	Trigger string
}

type record struct {
	body     map[string]any
	fetched  int
	complete bool
}

// Router is an http.Handler.
type Router struct {
	up   http.Handler
	opts Options

	seq atomic.Int64

	mu        sync.Mutex
	requests  []Request
	upstream  int
	spent     map[string]float64
	records   map[string]*record
	compacted map[string]bool
	route     *RouteScript
	routeSeen []RouteSeen
}

// New puts a fake router in front of upstream.
func New(upstream http.Handler, opts Options) *Router {
	if opts.Capabilities == nil {
		opts.Capabilities = []string{"autoroute", "route_hints", "result_headers", "budget_key"}
		if opts.Route != nil {
			opts.Capabilities = append(opts.Capabilities, "route_api")
		}
	}
	if opts.CostSource == "" {
		opts.CostSource = "reported"
	}
	return &Router{
		up: upstream, opts: opts, spent: map[string]float64{},
		records: map[string]*record{}, compacted: map[string]bool{}, route: opts.Route,
	}
}

// Requests returns the Messages requests seen so far, oldest first.
func (r *Router) Requests() []Request {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]Request(nil), r.requests...)
}

// UpstreamCalls counts the requests that reached the upstream handler.
func (r *Router) UpstreamCalls() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.upstream
}

// SetSpent sets the spend the router reports for a budget key (tests).
func (r *Router) SetSpent(key string, usd float64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.spent[key] = usd
}

// Spent is the fake's own spend for a budget key.
func (r *Router) Spent(key string) float64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.spent[key]
}

func (r *Router) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	switch {
	case req.Method == http.MethodGet && req.URL.Path == "/health":
		writeJSON(w, http.StatusOK, map[string]any{"service": "octo", "capabilities": r.opts.Capabilities})
	case req.Method == http.MethodGet && len(req.URL.Path) > len("/autoroute/v1/calls/") && req.URL.Path[:len("/autoroute/v1/calls/")] == "/autoroute/v1/calls/":
		r.callRecord(w, req.URL.Path[len("/autoroute/v1/calls/"):])
	case req.Method == http.MethodPost && req.URL.Path == "/autoroute/v1/route":
		r.routeEndpoint(w, req)
	case req.Method == http.MethodPost && req.URL.Path == "/v1/messages":
		r.messages(w, req)
	default:
		http.NotFound(w, req)
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

type messagesBody struct {
	Model    string            `json:"model"`
	Stream   bool              `json:"stream"`
	Messages []json.RawMessage `json:"messages"`
	Metadata struct {
		UserID string `json:"user_id"`
	} `json:"metadata"`
}

func (r *Router) messages(w http.ResponseWriter, req *http.Request) {
	raw, err := io.ReadAll(req.Body)
	var body messagesBody
	if err != nil || json.Unmarshal(raw, &body) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"type": "error", "error": map[string]string{"type": "invalid_request_error", "message": "bad body"}})
		return
	}
	h := req.Header
	key := h.Get("x-octo-budget-key")
	if key == "" {
		h = h.Clone()
		h.Del("x-octo-budget-usd") // like the real router: a budget needs a key
	}
	tier, trigger := decide(h)
	served := Ladder[tier]

	r.mu.Lock()
	id := "octo_" + strconv.FormatInt(r.seq.Add(1), 16)
	spent := r.spent[key]
	r.mu.Unlock()
	entry := Request{Header: h.Clone(), Body: raw, ID: id, Served: served, Tier: tier, Trigger: trigger}

	out := w.Header()
	out.Set("x-octo-request-id", id)
	var budget float64
	hasBudget := false
	if v, err := strconv.ParseFloat(h.Get("x-octo-budget-usd"), 64); err == nil {
		budget, hasBudget = v, true
		out.Set("x-octo-budget-usd", fmt.Sprint(v))
		out.Set("x-octo-spent-usd", fmt.Sprint(spent))
	}
	if (hasBudget && spent >= budget && !r.opts.IgnoreBudget) || (r.opts.RejectRole != "" && h.Get("x-octo-agent-role") == r.opts.RejectRole) {
		entry.Status = http.StatusPaymentRequired
		r.finish(entry)
		writeJSON(w, http.StatusPaymentRequired, map[string]any{"type": "error", "error": map[string]string{
			"type": "budget_exceeded", "message": "budget reached"}})
		return
	}

	session := key + "|" + body.Metadata.UserID
	if r.shouldCompact(session, len(body.Messages)) {
		entry.Trigger = "compact"
		out.Set("x-octo-model", served)
		out.Set("x-octo-tier", tier)
		out.Set("x-octo-trigger", "compact")
		in, outTok := 200, 40
		writeSummary(w, served, r.opts.CompactAsText)
		r.finishCall(entry, key, in, outTok)
		return
	}

	out.Set("x-octo-model", served)
	out.Set("x-octo-tier", tier)
	out.Set("x-octo-trigger", trigger)
	var patched map[string]json.RawMessage
	_ = json.Unmarshal(raw, &patched)
	patched["model"], _ = json.Marshal(served)
	newRaw, _ := json.Marshal(patched)
	req.Body = io.NopCloser(bytes.NewReader(newRaw))
	req.ContentLength = int64(len(newRaw))
	cw := &capture{ResponseWriter: w}
	r.mu.Lock()
	r.upstream++
	r.mu.Unlock()
	r.up.ServeHTTP(cw, req)
	in, outTok := cw.tokens()
	entry.Status = http.StatusOK
	r.finishCall(entry, key, in, outTok)
}

func (r *Router) shouldCompact(session string, n int) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.opts.CompactAt == 0 || n < r.opts.CompactAt || r.compacted[session] {
		return false
	}
	r.compacted[session] = true
	return true
}

func (r *Router) finish(e Request) {
	r.mu.Lock()
	r.requests = append(r.requests, e)
	r.mu.Unlock()
}
