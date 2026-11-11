package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/anthropics/anthropic-sdk-go/v2"
	"github.com/anthropics/anthropic-sdk-go/v2/option"

	"github.com/ndolinschi/Octo/apps/harness/internal/router"
)

const callRecordTimeout = 3 * time.Second

// request sends one Messages request. With an Octo router in the path it adds
// the hint headers, reads the result headers, and turns the router's 402 into
// a *router.BudgetError. A failed or cancelled request that the router already
// handled still gets a usage row.
func (l *Loop) request(ctx context.Context, params anthropic.MessageNewParams) (anthropic.Message, router.Result, error) {
	if !l.Router.Enabled() {
		resp, err := l.call(ctx, params, nil, nil)
		return resp, router.Result{}, err
	}
	var httpResp *http.Response
	opts := []option.RequestOption{option.WithResponseInto(&httpResp)}
	for name, v := range l.Hints.Header() {
		opts = append(opts, option.WithHeader(name, v[0]))
	}
	resp, err := l.call(ctx, params, opts, &httpResp)
	var res router.Result
	if httpResp != nil {
		res = router.ParseResult(httpResp.Header)
	}
	if res.SpentUSD != nil {
		l.Router.NoteSpent(l.Hints.BudgetKey, *res.SpentUSD)
	}
	if err == nil {
		return resp, res, nil
	}
	if res.RequestID != "" {
		l.Sink.Usage(l.usageOf(ctx, resp, res))
	}
	var apiErr *anthropic.Error
	if errors.As(err, &apiErr) && apiErr.StatusCode == http.StatusPaymentRequired {
		return resp, res, l.budgetError(res)
	}
	return resp, res, err
}

// budgetError builds the "Project budget reached" error from the 402's result
// headers, else from the last known spend and the project's budget.
func (l *Loop) budgetError(res router.Result) error {
	be := &router.BudgetError{Spent: -1, Budget: -1}
	switch {
	case res.SpentUSD != nil:
		be.Spent = *res.SpentUSD
	default:
		if v, ok := l.Router.Spent(l.Hints.BudgetKey); ok {
			be.Spent = v
		}
	}
	switch {
	case res.BudgetUSD != nil:
		be.Budget = *res.BudgetUSD
	case l.Hints.BudgetUSD != nil:
		be.Budget = *l.Hints.BudgetUSD
	}
	return be
}

// usageOf is the usage row for a response (possibly partial, for a failed
// stream). With a router it adds the served model, tier and trigger from the
// result headers and, when the router's call record can be fetched, its cost
// and token counts. Without the record the cost stays nil, which makes the
// usage report estimate it from the price table and mark it estimated.
func (l *Loop) usageOf(ctx context.Context, resp anthropic.Message, res router.Result) Usage {
	u := Usage{
		Model:            l.Model,
		InputTokens:      resp.Usage.InputTokens,
		OutputTokens:     resp.Usage.OutputTokens,
		CacheReadTokens:  resp.Usage.CacheReadInputTokens,
		CacheWriteTokens: resp.Usage.CacheCreationInputTokens,
	}
	if res.RequestID == "" && !res.Any() {
		return u
	}
	u.ServedModel, u.Tier, u.Trigger, u.RequestID = res.Model, res.Tier, res.Trigger, res.RequestID
	if res.RequestID == "" {
		return u
	}
	fctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), callRecordTimeout)
	defer cancel()
	rec, err := l.Router.FetchCall(fctx, res.RequestID)
	if err != nil {
		slog.Warn("router call record unavailable; cost will be estimated", "request", res.RequestID, "err", err)
		return u
	}
	for dst, src := range map[*string]string{&u.ServedModel: rec.Model, &u.Tier: rec.Tier, &u.Trigger: rec.Trigger} {
		if src != "" {
			*dst = src
		}
	}
	if resp.Usage.InputTokens+resp.Usage.OutputTokens == 0 {
		u.InputTokens, u.OutputTokens = rec.InputTokens, rec.OutputTokens
		u.CacheReadTokens, u.CacheWriteTokens = rec.CacheReadTokens, rec.CacheWriteTokens
	}
	switch {
	case rec.CostUSD == nil, *rec.CostUSD == 0 && rec.CostSource == router.CostEstimated:
		// No cost, or "estimated 0" which the router uses for "no price known":
		// leave it unknown so the report estimates from the harness's own prices.
	default:
		u.CostUSD = rec.CostUSD
		u.CostEstimated = rec.CostSource == router.CostEstimated
	}
	if res.SpentUSD != nil && u.CostUSD != nil {
		// The header is the spend before this response; add this call's cost.
		l.Router.NoteSpent(l.Hints.BudgetKey, *res.SpentUSD+*u.CostUSD)
	}
	return u
}

// readJSONMessage decodes a non-streamed Messages body.
func readJSONMessage(body io.Reader) (anthropic.Message, error) {
	raw, err := io.ReadAll(io.LimitReader(body, 32<<20))
	if err != nil {
		return anthropic.Message{}, err
	}
	var m anthropic.Message
	if err := json.Unmarshal(raw, &m); err != nil {
		return anthropic.Message{}, fmt.Errorf("router response: %w", err)
	}
	return m, nil
}
