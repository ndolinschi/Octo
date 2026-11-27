package orchestrator

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// limitError marks a failure the agent reported as a usage or rate limit;
// resetsAt is when the limit lifts, when the agent said so. transient is a bare
// rate limit (HTTP 429, RATE_LIMIT_EXCEEDED) that says nothing about the plan:
// it fails the turn and offers another account or model, but is not recorded
// as the agent's limit.
type limitError struct {
	resetsAt  *time.Time
	transient bool
	cause     error
}

func (e *limitError) Error() string {
	if e.cause != nil {
		return "usage limit reached: " + e.cause.Error()
	}
	return "usage limit reached"
}

func (e *limitError) Unwrap() error { return e.cause }

// Error codes and names agents use (Gemini CLI): an exhausted quota is a plan
// limit; RATE_LIMIT_EXCEEDED is a transient rate limit.
var (
	quotaCodes = []string{"QUOTA_EXHAUSTED"}
	rateCodes  = []string{"RATE_LIMIT_EXCEEDED"}
)

// limitFields is what an agent error says about a limit, read from its fields
// and its structured data.
type limitFields struct {
	kind   string
	codes  []string
	status int
	// messages: the error's own message, then any "message" of its data
	// (a generic "Request failed" can carry the limit text in data.error.message).
	messages []string
	resetsAt *time.Time
}

// rpcLimit reports whether err is a JSON-RPC refusal that says the agent hit a
// usage limit. It is consulted on error paths only, after the login check.
func rpcLimit(ag plugins.Agent, err error) (*limitError, bool) {
	var rpcErr *acp.RPCError
	if !errors.As(err, &rpcErr) {
		return nil, false
	}
	f := limitFields{messages: []string{rpcErr.Message}}
	f.read(rpcErr.Data)
	return f.classify(ag)
}

// limitFailure is the catalogue error for a limit hit of ag: the agent's plan
// limit, or a transient rate limit; another account is offered only when the
// agent can keep several.
func limitFailure(ag plugins.Agent, hit *limitError, details string) *usererr.Error {
	accounts := ag.AccountOf != "" || ag.AccountEnv != ""
	if hit.transient {
		return usererr.AgentRateLimited(ag.Label, details, accounts).Caused(hit)
	}
	return usererr.AgentLimitReached(ag.Label, details, accounts).Caused(hit)
}

// agentErrorLimit is rpcLimit for a mid-turn "agent_error" update.
func agentErrorLimit(ag plugins.Agent, ae acp.AgentError) (*limitError, bool) {
	f := limitFields{messages: []string{ae.Message}, status: ae.StatusCode, codes: []string{ae.Code, ae.Name}}
	f.read(ae.Data)
	return f.classify(ag)
}

// classify applies the rules in order: a structured errorKind "rate_limit"; a
// quota code or name; HTTP status 429; the agent's manifest limitPatterns
// against the message. Only a hit of the structured kind, a quota code or a
// pattern is a plan limit; a bare 429 or RATE_LIMIT_EXCEEDED is transient.
func (f limitFields) classify(ag plugins.Agent) (*limitError, bool) {
	hit := &limitError{resetsAt: f.resetsAt}
	switch {
	case f.kind == "rate_limit", f.hasCode(quotaCodes):
		return hit, true
	}
	for _, re := range ag.LimitPatterns {
		for _, m := range f.messages {
			if m != "" && re.MatchString(m) {
				return hit, true
			}
		}
	}
	if f.hasCode(rateCodes) || f.status == http.StatusTooManyRequests {
		hit.transient = true
		return hit, true
	}
	return nil, false
}

func (f limitFields) hasCode(codes []string) bool {
	for _, c := range f.codes {
		for _, want := range codes {
			if strings.EqualFold(strings.TrimSpace(c), want) {
				return true
			}
		}
	}
	return false
}

// read collects the limit fields of a JSON error object: at its top level and
// in nested "data" and "error" objects.
func (f *limitFields) read(raw json.RawMessage) {
	if len(raw) == 0 {
		return
	}
	var obj map[string]any
	if json.Unmarshal(raw, &obj) != nil {
		return
	}
	f.readObject(obj, 0)
}

func (f *limitFields) readObject(obj map[string]any, depth int) {
	if depth > 3 {
		return
	}
	if s, ok := obj["errorKind"].(string); ok && f.kind == "" {
		f.kind = s
	}
	if s, ok := obj["message"].(string); ok {
		f.messages = append(f.messages, s)
	}
	for _, k := range []string{"code", "name", "status", "reason"} {
		if s, ok := obj[k].(string); ok {
			f.codes = append(f.codes, s)
		}
	}
	for _, k := range []string{"statusCode", "status"} {
		if n, ok := obj[k].(float64); ok && f.status == 0 {
			f.status = int(n)
		}
	}
	if rl, ok := obj["rateLimit"].(map[string]any); ok && f.resetsAt == nil {
		f.resetsAt = parseResetsAt(rl["resetsAt"])
	}
	for _, k := range []string{"data", "error"} {
		if sub, ok := obj[k].(map[string]any); ok {
			f.readObject(sub, depth+1)
		}
	}
}

// unixMilliFrom: a Unix time this large is in milliseconds (as JS CLIs write
// Date.now()); in seconds it would be past the year 33000.
const unixMilliFrom = 1e12

// parseResetsAt reads an RFC 3339 time or a Unix time in seconds or
// milliseconds (number or digits); nil otherwise.
func parseResetsAt(v any) *time.Time {
	var t time.Time
	switch x := v.(type) {
	case float64:
		if x <= 0 {
			return nil
		}
		t = unixTime(int64(x))
	case string:
		if p, err := time.Parse(time.RFC3339, x); err == nil {
			t = p
		} else if n, err := strconv.ParseInt(x, 10, 64); err == nil && n > 0 {
			t = unixTime(n)
		} else {
			return nil
		}
	default:
		return nil
	}
	t = t.UTC()
	return &t
}

func unixTime(n int64) time.Time {
	if n >= unixMilliFrom {
		return time.UnixMilli(n)
	}
	return time.Unix(n, 0)
}

// noteLimit passes what a run of an ACP agent showed about its usage limit to
// OnAgentLimit: a plan limit failure marks it reached, a successful run clears
// it. A transient rate limit changes nothing.
func (o *Orchestrator) noteLimit(agentID string, err error) {
	if o.opts.OnAgentLimit == nil || agentID == "" {
		return
	}
	var le *limitError
	switch {
	case err == nil:
		o.opts.OnAgentLimit(agentID, nil, false)
	case errors.As(err, &le) && le.transient:
	case errors.As(err, &le):
		o.opts.OnAgentLimit(agentID, le.resetsAt, true)
	}
}
