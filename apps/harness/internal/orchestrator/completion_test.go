package orchestrator_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/completion"
	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakerouter"
	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/router"
	"github.com/ndolinschi/Octo/apps/harness/internal/secrets"
)

// completionLLM records the completion requests and answers them with the
// mock model; a request whose body has "[hang]" never answers and signals
// aborted when the client goes away.
type completionLLM struct {
	mock    http.Handler
	mu      sync.Mutex
	bodies  []string
	aborted chan struct{}
	started chan struct{}
}

func newCompletionLLM() *completionLLM {
	return &completionLLM{mock: mockllm.New(0), aborted: make(chan struct{}, 4), started: make(chan struct{}, 4)}
}

func (c *completionLLM) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	if strings.Contains(string(raw), completionSystemStart) {
		c.mu.Lock()
		c.bodies = append(c.bodies, string(raw))
		c.mu.Unlock()
		if strings.Contains(string(raw), "[hang]") {
			c.started <- struct{}{}
			<-r.Context().Done()
			c.aborted <- struct{}{}
			return
		}
	}
	r.Body = io.NopCloser(strings.NewReader(string(raw)))
	c.mock.ServeHTTP(w, r)
}

const completionSystemStart = "You complete code at the cursor"

func (c *completionLLM) requests() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.bodies...)
}

func completionRig(t *testing.T, model string) (*rig, *completionLLM, string) {
	t.Helper()
	llm := newCompletionLLM()
	r := newRigWith(t, llm, orchestrator.Options{})
	pid := r.project(t, 1)
	if model != "" {
		r.update(t, pid, project.Input{Models: &config.Models{Completion: model}})
	}
	return r, llm, pid
}

func TestCompletionOffWithoutAModel(t *testing.T) {
	r, llm, pid := completionRig(t, "")
	_, _, err := r.orch.Complete(context.Background(), pid, completion.Request{Path: "a.go", Prefix: "x"})
	var off *orchestrator.CompletionOffError
	if !errors.As(err, &off) || !strings.Contains(off.Reason, "models.completion") {
		t.Fatalf("err = %v, want a CompletionOffError naming the setting", err)
	}
	if len(llm.requests()) != 0 {
		t.Fatal("a model call was made while completion is off")
	}
}

func TestCompletionAnswersAndRecordsUsageRoleCompletion(t *testing.T) {
	r, llm, pid := completionRig(t, "fast")
	res, skipped, err := r.orch.Complete(context.Background(), pid, completion.Request{
		Path: "main.go", Language: "go", Prefix: "func f() {\n\t[complete: return 1]", Suffix: "\n}\n",
	})
	if err != nil || skipped != "" {
		t.Fatalf("err=%v skipped=%q", err, skipped)
	}
	if res.Text != "return 1" || res.Model == "" {
		t.Fatalf("result = %+v", res)
	}
	reqs := llm.requests()
	if len(reqs) != 1 {
		t.Fatalf("requests = %d", len(reqs))
	}
	var body struct {
		Model         string          `json:"model"`
		MaxTokens     int             `json:"max_tokens"`
		Temperature   *float64        `json:"temperature"`
		StopSequences []string        `json:"stop_sequences"`
		Tools         json.RawMessage `json:"tools"`
		Stream        bool            `json:"stream"`
	}
	if err := json.Unmarshal([]byte(reqs[0]), &body); err != nil {
		t.Fatal(err)
	}
	if body.MaxTokens != completion.MaxTokens || body.Temperature == nil || *body.Temperature != 0 || body.Model != res.Model {
		t.Fatalf("request params = %+v", body)
	}
	if len(body.Tools) > 2 && string(body.Tools) != "null" {
		t.Fatalf("completion request carries tools: %s", body.Tools)
	}
	log := r.usageLog(t, pid)
	var n int
	for _, e := range log {
		if e.Role == orchestrator.UsageRoleCompletion {
			n++
			if e.InputTokens == 0 {
				t.Fatalf("completion usage row has no tokens: %+v", e)
			}
		}
	}
	if n != 1 {
		t.Fatalf("usage rows with role completion = %d (log %+v)", n, log)
	}
	// Not part of any agent's totals.
	agents := r.agents(t, pid)
	if agents[0].InputTokens != 0 {
		t.Fatalf("orchestrator input tokens = %v, want the completion left out", agents[0].InputTokens)
	}
}

func TestCompletionStopSequenceFollowsTheBlock(t *testing.T) {
	r, llm, pid := completionRig(t, "fast")
	if _, _, err := r.orch.Complete(context.Background(), pid, completion.Request{Path: "a.go", Prefix: "x := 1\n"}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := r.orch.Complete(context.Background(), pid, completion.Request{Path: "a.go", Prefix: "func f() {\n\t"}); err != nil {
		t.Fatal(err)
	}
	reqs := llm.requests()
	if len(reqs) != 2 || !strings.Contains(reqs[0], `"stop_sequences":["\n\n"]`) || strings.Contains(reqs[1], "stop_sequences") {
		t.Fatalf("stop sequences wrong: %v", reqs)
	}
}

func TestCompletionNeverSendsSecretFilesOrBigOnes(t *testing.T) {
	r, llm, pid := completionRig(t, "fast")
	for _, p := range []string{".env", "config/.env.local", "server.pem", "id_rsa", ".git/config", "a/b/key.key"} {
		_, skipped, err := r.orch.Complete(context.Background(), pid, completion.Request{Path: p, Prefix: "x"})
		if err != nil || skipped == "" {
			t.Fatalf("%s: skipped=%q err=%v, want it skipped", p, skipped, err)
		}
	}
	_, skipped, err := r.orch.Complete(context.Background(), pid, completion.Request{Path: "a.txt", Prefix: "x\x00y"})
	if err != nil || skipped == "" {
		t.Fatalf("binary text: skipped=%q err=%v", skipped, err)
	}
	if len(llm.requests()) != 0 {
		t.Fatal("a never-sent file reached the model")
	}
	// A snippet from a secret file is dropped, the request still goes.
	_, skipped, err = r.orch.Complete(context.Background(), pid, completion.Request{
		Path: "a.go", Prefix: "x", Snippets: []completion.Snippet{{Path: ".env", Text: "API_TOKEN=hunter2hunter2"}, {Path: "b.go", Text: "package b"}},
	})
	if err != nil || skipped != "" {
		t.Fatalf("skipped=%q err=%v", skipped, err)
	}
	reqs := llm.requests()
	if len(reqs) != 1 || strings.Contains(reqs[0], "hunter2") || !strings.Contains(reqs[0], "package b") {
		t.Fatalf("snippets sent wrongly: %v", reqs)
	}
}

func TestCompletionRedactsStoredSecrets(t *testing.T) {
	r, llm, pid := completionRig(t, "fast")
	const value = "s3cr3t-value-ABCDEF123456"
	if err := r.svc.PutSecret(context.Background(), pid, "api_key", value); err != nil {
		t.Fatal(err)
	}
	res, _, err := r.orch.Complete(context.Background(), pid, completion.Request{
		Path: "a.go", Prefix: `key := "` + value + `"` + "\nuse(", Suffix: ")\n// " + value,
		Snippets: []completion.Snippet{{Path: "b.go", Text: "const k = \"" + value + "\""}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if reqs := llm.requests(); len(reqs) != 1 || !strings.Contains(reqs[0], secrets.Mask) {
		t.Fatalf("the redacted request lacks the mask: %v", reqs)
	}
	for _, q := range llm.requests() {
		if strings.Contains(q, value) {
			t.Fatalf("secret value left the machine: %s", q)
		}
	}
	if strings.Contains(res.Text, value) {
		t.Fatal("secret value in the result")
	}
	for _, e := range r.usageLog(t, pid) {
		if b, _ := json.Marshal(e); strings.Contains(string(b), value) {
			t.Fatal("secret value in usage")
		}
	}
}

func TestCompletionCancellationAbortsTheUpstreamRequest(t *testing.T) {
	r, llm, pid := completionRig(t, "fast")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, _, err := r.orch.Complete(ctx, pid, completion.Request{Path: "a.go", Prefix: "[hang]"})
		done <- err
	}()
	select {
	case <-llm.started:
	case <-time.After(10 * time.Second):
		t.Fatal("the upstream request never started")
	}
	cancel()
	select {
	case <-llm.aborted:
	case <-time.After(10 * time.Second):
		t.Fatal("the upstream request was not aborted")
	}
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err = %v, want context.Canceled", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Complete did not return after cancel")
	}
}

func TestCompletionTierResolution(t *testing.T) {
	for _, tc := range []struct{ setting, want string }{
		{"fast", config.DefaultModels().Fast}, {"balanced", config.DefaultModels().Balanced}, {"my-fim-model", "my-fim-model"},
	} {
		r, _, pid := completionRig(t, tc.setting)
		res, _, err := r.orch.Complete(context.Background(), pid, completion.Request{Path: "a.go", Prefix: "x"})
		if err != nil || res.Model != tc.want {
			t.Fatalf("%s: model=%q err=%v, want %q", tc.setting, res.Model, err, tc.want)
		}
	}
}

func TestCompletionOffClearsTheSetting(t *testing.T) {
	r, llm, pid := completionRig(t, "fast")
	r.update(t, pid, project.Input{Models: &config.Models{Completion: config.CompletionOff}})
	p, err := r.svc.Get(context.Background(), pid)
	if err != nil || p.Models.Completion != "" {
		t.Fatalf("completion after off = %q (%v)", p.Models.Completion, err)
	}
	var off *orchestrator.CompletionOffError
	if _, _, err := r.orch.Complete(context.Background(), pid, completion.Request{Path: "a.go", Prefix: "x"}); !errors.As(err, &off) {
		t.Fatalf("err = %v", err)
	}
	if len(llm.requests()) != 0 {
		t.Fatal("model call after off")
	}
}

func TestCompletionRejectsAnACPAgent(t *testing.T) {
	r, _, pid := completionRig(t, "")
	_, err := r.svc.Update(context.Background(), pid, project.Input{Models: &config.Models{Completion: "acp:claude-code"}})
	if err == nil || !strings.Contains(err.Error(), "models.completion") {
		t.Fatalf("err = %v, want a models.completion validation error", err)
	}
}

func TestCompletionStopsAtTheBudgetWithoutACall(t *testing.T) {
	llm := newCompletionLLM()
	r, fr := newFakeRig(t, llm, fakerouter.Options{Rates: pricey}, orchestrator.Options{})
	pid := r.project(t, 1)
	r.update(t, pid, project.Input{Models: &config.Models{Completion: "fast"}})
	r.update(t, pid, budgetInput(0.01))
	// The first completion is allowed and spends more than the budget ...
	if _, _, err := r.orch.Complete(context.Background(), pid, completion.Request{Path: "a.go", Prefix: "x"}); err != nil {
		t.Fatal(err)
	}
	calls := fr.UpstreamCalls()
	// ... the second is refused before any request is made.
	_, _, err := r.orch.Complete(context.Background(), pid, completion.Request{Path: "a.go", Prefix: "y"})
	if !router.IsBudget(err) {
		t.Fatalf("err = %v, want a budget error", err)
	}
	if fr.UpstreamCalls() != calls {
		t.Fatal("a request was made after the budget was reached")
	}
	// The router hints: lowest tier, fixed, marked as a completion.
	var seen bool
	for _, q := range fr.Requests() {
		if q.Header.Get("x-octo-tier-hint") == "fast" && q.Header.Get("x-octo-task") == "completion" && q.Header.Get("x-octo-budget-key") == pid {
			seen = true
		}
	}
	if !seen {
		t.Fatalf("no request with the completion hints: %v", fr.Requests())
	}
}

func TestCompletionUpstreamFailureIsReported(t *testing.T) {
	bad := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"type":"error","error":{"type":"invalid_request_error","message":"nope"}}`, 400)
	})
	r := newRigWith(t, bad, orchestrator.Options{})
	pid := r.project(t, 1)
	r.update(t, pid, project.Input{Models: &config.Models{Completion: "fast"}})
	_, _, err := r.orch.Complete(context.Background(), pid, completion.Request{Path: "a.go", Prefix: "x"})
	var failed *orchestrator.CompletionFailedError
	if !errors.As(err, &failed) {
		t.Fatalf("err = %v, want CompletionFailedError", err)
	}
}

func TestCompletionSmallTierOllamaDirect(t *testing.T) {
	var seenModel, seenPrompt, seenSuffix string
	ollamaSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/generate" {
			http.NotFound(w, r)
			return
		}
		var body struct {
			Model  string `json:"model"`
			Prompt string `json:"prompt"`
			Suffix string `json:"suffix"`
			Stream bool   `json:"stream"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		seenModel, seenPrompt, seenSuffix = body.Model, body.Prompt, body.Suffix
		_ = json.NewEncoder(w).Encode(map[string]any{
			"response":          "return 42",
			"prompt_eval_count": 12,
			"eval_count":        4,
		})
	}))
	t.Cleanup(ollamaSrv.Close)

	llm := newCompletionLLM()
	r := newRigWith(t, llm, orchestrator.Options{
		BuiltinUnavailable:   config.NoBuiltinLoopMessage,
		OllamaBaseURL:        ollamaSrv.URL,
		SmallCompletionModel: "qwen2.5-coder:1.5b",
	})
	pid := r.project(t, 1)
	r.update(t, pid, project.Input{Models: &config.Models{Completion: config.CompletionSmall}})

	res, skipped, err := r.orch.Complete(context.Background(), pid, completion.Request{
		Path: "main.go", Language: "go", Prefix: "func answer() int {\n\t", Suffix: "\n}\n",
		Snippets: []completion.Snippet{{Path: "types.go", Text: "type X int"}},
	})
	if err != nil || skipped != "" {
		t.Fatalf("err=%v skipped=%q", err, skipped)
	}
	if res.Text != "return 42" || res.Model != "qwen2.5-coder:1.5b" {
		t.Fatalf("res = %+v", res)
	}
	if seenModel != "qwen2.5-coder:1.5b" || !strings.Contains(seenPrompt, "type X int") || seenSuffix != "\n}\n" {
		t.Fatalf("ollama request = (%q, %q, %q)", seenModel, seenPrompt, seenSuffix)
	}
	if len(llm.requests()) != 0 {
		t.Fatal("small tier hit Anthropic Messages loop instead of Ollama")
	}

	// Live SetOllama updates the model immediately.
	r.orch.SetOllama(ollamaSrv.URL, "starcoder2:3b")
	res, _, err = r.orch.Complete(context.Background(), pid, completion.Request{Path: "main.go", Prefix: "x := "})
	if err != nil || res.Model != "starcoder2:3b" || seenModel != "starcoder2:3b" {
		t.Fatalf("after SetOllama res=%+v seenModel=%q err=%v", res, seenModel, err)
	}

	// Explicit ollama:<tag> overrides settings.
	r.update(t, pid, project.Input{Models: &config.Models{Completion: "ollama:codellama:7b"}})
	res, _, err = r.orch.Complete(context.Background(), pid, completion.Request{Path: "main.go", Prefix: "y := "})
	if err != nil || res.Model != "codellama:7b" || seenModel != "codellama:7b" {
		t.Fatalf("explicit ollama tag res=%+v seenModel=%q err=%v", res, seenModel, err)
	}
}

func TestCompletionSmallTierThroughRouter(t *testing.T) {
	llm := newCompletionLLM()
	r, fr := newFakeRig(t, llm, fakerouter.Options{Rates: pricey}, orchestrator.Options{})
	pid := r.project(t, 1)
	r.update(t, pid, project.Input{Models: &config.Models{Completion: config.CompletionSmall}})

	res, _, err := r.orch.Complete(context.Background(), pid, completion.Request{Path: "a.go", Prefix: "x"})
	if err != nil || res.Model != config.DefaultOllamaSmallModel {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	var seenSmall bool
	for _, q := range fr.Requests() {
		if q.Header.Get("x-octo-tier-hint") == config.CompletionSmall && q.Header.Get("x-octo-task") == "completion" {
			seenSmall = true
		}
	}
	if !seenSmall {
		t.Fatalf("expected x-octo-tier-hint: small on router request, got %v", fr.Requests())
	}
}
