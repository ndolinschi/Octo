package router

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"sync"
	"time"
)

// CapRouteOutcome is the capability of a router that stores delegation
// records and takes outcome reports (POST /autoroute/v1/route/{id}/outcome).
const CapRouteOutcome = "route_outcome"

// Outcome events.
const (
	EventFinished    = "finished"
	EventRedelegated = "redelegated"
	EventEscalated   = "escalated"
	EventRewound     = "rewound"
	EventReverted    = "reverted"
)

// Finish statuses of a delegated sub-agent.
const (
	StatusCompleted  = "completed"
	StatusFailed     = "failed"
	StatusStopped    = "stopped"
	StatusTimedOut   = "timed_out"
	StatusAgentError = "agent_error"
)

// Agent signals: what the sub-agent's own final report said.
const (
	SignalDone     = "done"
	SignalCouldNot = "could_not"
	SignalNone     = "none"
)

// OutcomeUsage is what the sub-agent used, as the harness measured it.
type OutcomeUsage struct {
	Turns            int64    `json:"turns"`
	ToolCalls        int64    `json:"tool_calls"`
	FailedToolCalls  int64    `json:"failed_tool_calls"`
	InputTokens      int64    `json:"input_tokens"`
	OutputTokens     int64    `json:"output_tokens"`
	CacheReadTokens  int64    `json:"cache_read_tokens"`
	CacheWriteTokens int64    `json:"cache_write_tokens"`
	CostUSD          *float64 `json:"cost_usd"`
	CostEstimated    bool     `json:"cost_estimated"`
	FlatRate         bool     `json:"flat_rate"`
}

// OutcomeTests is a test result the harness knows itself.
type OutcomeTests struct {
	Status string `json:"status"` // pass | fail | unknown
	Passed *int64 `json:"passed,omitempty"`
	Failed *int64 `json:"failed,omitempty"`
}

// Outcome is one report about a delegation. ReportID makes it idempotent: the
// router stores the same id once.
type Outcome struct {
	ReportID     string        `json:"report_id"`
	Event        string        `json:"event"`
	Status       string        `json:"status,omitempty"`
	AgentSignal  string        `json:"agent_signal,omitempty"`
	ErrorKind    string        `json:"error_kind,omitempty"`
	SessionID    string        `json:"session_id,omitempty"`
	Usage        *OutcomeUsage `json:"usage,omitempty"`
	DurationMS   *int64        `json:"duration_ms,omitempty"`
	Tests        *OutcomeTests `json:"tests,omitempty"`
	By           string        `json:"by,omitempty"`
	AfterFailure *bool         `json:"after_failure,omitempty"`
	Reason       string        `json:"reason,omitempty"`
	At           string        `json:"at,omitempty"`
}

// OutcomeAck is the router's answer: whether it stored the report and the
// delegation's derived label.
type OutcomeAck struct {
	Stored     bool   `json:"stored"`
	Solved     string `json:"solved"`
	Rule       string `json:"rule"`
	Confidence string `json:"confidence"`
}

// Defaults of the outcome sender.
const (
	outcomeAttempts = 3
	outcomeTimeout  = 3 * time.Second
	outcomeBackoff  = 500 * time.Millisecond
)

// outcomes counts reports in flight (WaitOutcomes) and holds the sender's
// retry pause (tests shorten it).
type outcomes struct {
	wg      sync.WaitGroup
	backoff time.Duration
}

// WithOutcomeBackoff overrides the first pause between outcome retries.
func WithOutcomeBackoff(d time.Duration) Option {
	return func(r *Router) { r.out.backoff = d }
}

// ReportOutcome sends one report and waits for the answer: at most
// outcomeAttempts tries, each bounded by outcomeTimeout, with a doubling pause
// between them. Only a connection failure, a 5xx or a 404 (the record may not be
// written yet) is retried. It does nothing (and errors) when the router does not
// take outcomes.
func (r *Router) ReportOutcome(ctx context.Context, requestID string, o Outcome) (OutcomeAck, error) {
	if r == nil || r.origin == "" || requestID == "" || !r.Has(CapRouteOutcome) {
		return OutcomeAck{}, fmt.Errorf("router: outcome reports are not available")
	}
	if o.At == "" {
		o.At = time.Now().UTC().Format(time.RFC3339)
	}
	body, err := json.Marshal(o)
	if err != nil {
		return OutcomeAck{}, err
	}
	wait := r.out.backoff
	if wait <= 0 {
		wait = outcomeBackoff
	}
	var last error
	for attempt := 0; attempt < outcomeAttempts; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return OutcomeAck{}, ctx.Err()
			case <-time.After(wait):
			}
			wait *= 2
		}
		ack, retry, err := r.postOutcome(ctx, requestID, body)
		if err == nil {
			return ack, nil
		}
		last = err
		if !retry {
			break
		}
	}
	return OutcomeAck{}, last
}

func (r *Router) postOutcome(ctx context.Context, requestID string, body []byte) (OutcomeAck, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, outcomeTimeout)
	defer cancel()
	u := r.origin + "/autoroute/v1/route/" + url.PathEscape(requestID) + "/outcome"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(body))
	if err != nil {
		return OutcomeAck{}, false, err
	}
	req.Header.Set("Content-Type", "application/json")
	if r.octoKey != "" {
		req.Header.Set("x-octo-key", r.octoKey)
	}
	resp, err := r.http.Do(req)
	if err != nil {
		return OutcomeAck{}, true, fmt.Errorf("router: outcome report: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	switch {
	case resp.StatusCode == http.StatusOK:
	case resp.StatusCode == http.StatusNotFound || resp.StatusCode >= 500:
		return OutcomeAck{}, true, fmt.Errorf("router: outcome report: HTTP %d %s", resp.StatusCode, clip(string(raw)))
	default:
		return OutcomeAck{}, false, fmt.Errorf("router: outcome report: HTTP %d %s", resp.StatusCode, clip(string(raw)))
	}
	var ack OutcomeAck
	if err := json.Unmarshal(raw, &ack); err != nil {
		return OutcomeAck{}, false, fmt.Errorf("router: outcome report: unreadable answer")
	}
	return ack, false, nil
}

// SendOutcome is ReportOutcome in the background: it never blocks the caller
// and never fails its work; a report that cannot be delivered is logged at
// debug level and dropped. The router's lifetime context bounds it.
func (r *Router) SendOutcome(requestID string, o Outcome) {
	if r == nil || requestID == "" || !r.Has(CapRouteOutcome) {
		return
	}
	r.out.wg.Add(1)
	go func() {
		defer r.out.wg.Done()
		if _, err := r.ReportOutcome(r.life, requestID, o); err != nil {
			slog.Debug("delegation outcome not delivered", "request", requestID, "event", o.Event, "err", err)
		}
	}()
}

// WaitOutcomes waits for the reports SendOutcome has in flight (tests, shutdown).
func (r *Router) WaitOutcomes() {
	if r != nil {
		r.out.wg.Wait()
	}
}
