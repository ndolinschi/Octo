package router

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// Cost sources in a call record.
const CostEstimated = "estimated"

// Call is the router's record of one finished request, from
// GET /autoroute/v1/calls/{request-id}.
type Call struct {
	Model            string   `json:"model"`
	Tier             string   `json:"tier"`
	Trigger          string   `json:"trigger"`
	InputTokens      int64    `json:"input_tokens"`
	OutputTokens     int64    `json:"output_tokens"`
	CacheReadTokens  int64    `json:"cache_read_tokens"`
	CacheWriteTokens int64    `json:"cache_write_tokens"`
	CostUSD          *float64 `json:"cost_usd"`
	// CostSource is "reported" (the upstream said so) or "estimated".
	CostSource string `json:"cost_source"`
	// SpentAfterUSD, when the router provides it, is the budget key's spend once
	// this call was charged, classifier cost included. The result header
	// x-octo-spent-usd excludes the response it comes with.
	SpentAfterUSD *float64 `json:"spent_after_usd"`
}

var errNotReady = errors.New("router: call record not ready")

// FetchCall reads the call record once and, when it is not available yet
// (404), once more after a short pause. ctx's deadline bounds both attempts;
// callers pass a context detached from a cancelled turn.
func (r *Router) FetchCall(ctx context.Context, id string) (Call, error) {
	if r == nil || id == "" {
		return Call{}, errors.New("router: no call id")
	}
	c, err := r.fetchCall(ctx, id)
	if !errors.Is(err, errNotReady) {
		return c, err
	}
	select {
	case <-time.After(r.retryWait):
	case <-ctx.Done():
		return Call{}, ctx.Err()
	}
	return r.fetchCall(ctx, id)
}

func (r *Router) fetchCall(ctx context.Context, id string) (Call, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.origin+"/autoroute/v1/calls/"+url.PathEscape(id), nil)
	if err != nil {
		return Call{}, err
	}
	if r.octoKey != "" {
		req.Header.Set("x-octo-key", r.octoKey)
	}
	resp, err := r.http.Do(req)
	if err != nil {
		return Call{}, err
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusNotFound:
		return Call{}, errNotReady
	case resp.StatusCode != http.StatusOK:
		return Call{}, fmt.Errorf("router: call record: HTTP %d", resp.StatusCode)
	}
	var c Call
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&c); err != nil {
		return Call{}, fmt.Errorf("router: call record: %w", err)
	}
	return c, nil
}
