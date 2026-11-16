package orchestrator

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/ndolinschi/Octo/apps/harness/internal/agent"
	"github.com/ndolinschi/Octo/apps/harness/internal/completion"
	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/router"
	"github.com/ndolinschi/Octo/apps/harness/internal/secrets"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools/local"
)

// UsageRoleCompletion is the usage role of inline-completion requests: not in
// an agent's totals, counted in /v1/usage and the project's spend.
const UsageRoleCompletion = "completion"

// CompletionOffError says inline completion cannot run now (no model chosen,
// or no way to call one).
type CompletionOffError struct{ Reason string }

func (e *CompletionOffError) Error() string { return e.Reason }

// CompletionFailedError wraps a failed model call.
type CompletionFailedError struct{ Err error }

func (e *CompletionFailedError) Error() string {
	return "the completion model call failed: " + e.Err.Error()
}
func (e *CompletionFailedError) Unwrap() error { return e.Err }

// Complete answers one inline-completion request for a project: a single
// fill-in-the-middle call on the project's completion model, outside the turn
// machinery (it needs no turn slot and never touches the transcript). skipped
// is a reason the file was not sent (the never-sent list); the result is then
// empty. A cancelled ctx aborts the upstream request. The budget is checked
// first: with it reached the call is not made (a *router.BudgetError).
func (o *Orchestrator) Complete(ctx context.Context, pid string, req completion.Request) (res completion.Result, skipped string, err error) {
	db, err := o.store.Get(ctx, pid)
	if err != nil {
		return res, "", err
	}
	rt, err := o.newRuntime(ctx, db)
	if err != nil {
		return res, "", err
	}
	isSmall := rt.models.IsOllamaCompletion()
	model := rt.models.CompletionModel()
	switch {
	case model == "":
		return res, "", &CompletionOffError{"inline completion is off: choose a completion model (models.completion)"}
	case !isSmall && o.builtinOff() != "":
		return res, "", &CompletionOffError{o.builtinOff()}
	}
	size := int64(-1)
	if f, ok := rt.folderOf(req.Folder); ok {
		if abs, rerr := local.Resolve(f.Path, req.Path); rerr == nil {
			if st, serr := os.Stat(abs); serr == nil && st.Mode().IsRegular() {
				size = st.Size()
			}
		}
	}
	texts := []string{req.Prefix, req.Suffix}
	if why := completion.NeverSent(req.Path, size, texts...); why != "" {
		return res, why, nil
	}
	// What leaves the machine: secret values are removed from the path, the
	// text around the cursor and the snippets; snippets of never-sent files are dropped.
	clean := completion.Request{
		Path: o.secrets.Redact(pid, req.Path), Language: req.Language, MaxLines: req.MaxLines,
		Prefix: o.secrets.Redact(pid, req.Prefix), Suffix: o.secrets.Redact(pid, req.Suffix),
	}
	for _, s := range req.Snippets {
		if completion.NeverSent(s.Path, -1, s.Text) == "" {
			clean.Snippets = append(clean.Snippets, completion.Snippet{Path: o.secrets.Redact(pid, s.Path), Text: o.secrets.Redact(pid, s.Text)})
		}
	}
	if be := rt.budgetReached(ctx); be != nil {
		return res, "", be
	}
	orch, err := db.Orchestrator(ctx)
	if err != nil {
		return res, "", err
	}
	start := time.Now()
	var raw string
	routerOn := o.opts.Router != nil && o.opts.Router.Enabled()
	if isSmall && !routerOn {
		var u agent.Usage
		raw, u, err = o.completeOllama(ctx, o.ollamaBaseURL(), model, clean)
		if err == nil {
			(&digestSink{rt: rt, agentID: orch.ID, role: UsageRoleCompletion}).Usage(u)
		}
	} else {
		tierHint := string(projectstore.TierFast)
		gate := rt.loopGate()
		if isSmall {
			tierHint = config.CompletionSmall
			gate = rt.gate()
		}
		temp := 0.0
		loop := agent.Loop{
			Client: o.opts.Client, Registry: tools.NewRegistry(), Model: model, System: completion.System,
			MaxTurns: 1, MaxTokens: completion.MaxTokens, Stream: false, SessionID: "completion:" + orch.ID,
			Temperature: &temp, StopSequences: completion.StopSequences(clean.Prefix),
			Sink:            &digestSink{rt: rt, agentID: orch.ID, role: UsageRoleCompletion},
			NoPromptCaching: true, Limits: o.opts.Limits, Router: o.opts.Router,
			Hints: router.Hints{
				BudgetKey: pid, Role: "sub", Depth: 1, TierHint: tierHint, TierPolicy: "fixed",
				Task: "completion", BudgetFn: rt.currentBudget,
			},
			Gate: gate,
		}
		var out agent.Result
		out, err = loop.Run(ctx, []anthropic.MessageParam{anthropic.NewUserMessage(anthropic.NewTextBlock(completion.UserMessage(clean)))})
		raw = out.Text
	}
	res.MS, res.Model = time.Since(start).Milliseconds(), model
	if err != nil {
		if ctx.Err() != nil {
			return res, "", ctx.Err()
		}
		if router.IsBudget(err) {
			var be *router.BudgetError
			if errors.As(err, &be) {
				return res, "", be
			}
		}
		return res, "", &CompletionFailedError{err}
	}
	text := completion.Clean(raw, clean.Prefix, clean.Suffix, clean.Lines())
	if strings.Contains(text, secrets.Mask) {
		text = ""
	}
	res.Text = text
	return res, "", nil
}

var ollamaHTTPClient = &http.Client{Timeout: 30 * time.Second}

func (o *Orchestrator) completeOllama(ctx context.Context, baseURL, model string, clean completion.Request) (string, agent.Usage, error) {
	var prompt strings.Builder
	for _, s := range clean.Snippets {
		fmt.Fprintf(&prompt, "<snippet path=%q>\n%s\n</snippet>\n", s.Path, s.Text)
	}
	prompt.WriteString(clean.Prefix)
	options := map[string]any{
		"temperature": 0,
		"num_predict": completion.MaxTokens,
	}
	if stops := completion.StopSequences(clean.Prefix); len(stops) > 0 {
		options["stop"] = stops
	}
	payload := struct {
		Model   string         `json:"model"`
		Prompt  string         `json:"prompt"`
		Suffix  string         `json:"suffix,omitempty"`
		Stream  bool           `json:"stream"`
		Options map[string]any `json:"options"`
	}{
		Model:   model,
		Prompt:  prompt.String(),
		Suffix:  clean.Suffix,
		Stream:  false,
		Options: options,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", agent.Usage{}, err
	}
	endpoint := strings.TrimRight(baseURL, "/") + "/api/generate"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return "", agent.Usage{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := ollamaHTTPClient.Do(req)
	if err != nil {
		return "", agent.Usage{}, err
	}
	defer resp.Body.Close()
	respBytes, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", agent.Usage{}, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		msg := strings.TrimSpace(string(respBytes))
		if msg == "" {
			msg = resp.Status
		}
		return "", agent.Usage{}, fmt.Errorf("ollama %s: %s", resp.Status, msg)
	}
	var out struct {
		Response        string `json:"response"`
		Error           string `json:"error"`
		PromptEvalCount int    `json:"prompt_eval_count"`
		EvalCount       int    `json:"eval_count"`
	}
	if err := json.Unmarshal(respBytes, &out); err != nil {
		return "", agent.Usage{}, fmt.Errorf("decode ollama response: %w", err)
	}
	if out.Error != "" {
		return "", agent.Usage{}, errors.New(out.Error)
	}
	return out.Response, agent.Usage{
		Model:        model,
		ServedModel:  model,
		Tier:         config.CompletionSmall,
		InputTokens:  out.PromptEvalCount,
		OutputTokens: out.EvalCount,
	}, nil
}
