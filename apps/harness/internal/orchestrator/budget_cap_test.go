package orchestrator_test

import (
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/prices"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// capLog is a fake model that keeps the max_tokens of every request and answers with an essay that runs until the
// request's limit when it is below the default (stop_reason max_tokens), else ends normally.
type capLog struct {
	mu   sync.Mutex
	max  []int64
	full int64
}

func (c *capLog) handler() http.Handler {
	return fakeLLM(func(w http.ResponseWriter, _ *http.Request, req fakeReq) {
		c.mu.Lock()
		c.max = append(c.max, req.MaxTokens)
		c.mu.Unlock()
		stop := "end_turn"
		if req.MaxTokens < c.full {
			stop = "max_tokens"
		}
		if req.Stream {
			streamText(w, "The essay ", "begins here")
			sse(w, "content_block_stop", `{"type":"content_block_stop","index":0}`)
			sse(w, "message_delta", fmt.Sprintf(`{"type":"message_delta","delta":{"stop_reason":%q},"usage":{"output_tokens":%d}}`, stop, req.MaxTokens))
			sse(w, "message_stop", `{"type":"message_stop"}`)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"id":"m","type":"message","role":"assistant","model":"x","content":[%s],"stop_reason":%q,"usage":{"input_tokens":3,"output_tokens":%d}}`,
			textBlock("The essay begins here"), stop, req.MaxTokens)
	})
}

// P2-11: under a budget, a request asks for no more output than the rest of the budget can buy at the model's
// price (never below a floor); an answer that reaches that cap ends the turn with the budget error saying it was
// stopped mid-request, and what it had written is kept, flagged cut short.
func TestBudgetCapsTheRequestAndStopsMidRequest(t *testing.T) {
	model := config.BuiltinModels().Orchestrator
	tab, err := prices.Parse(fmt.Sprintf("[models.%q]\ninput = 3\noutput = 15\n", model)) // $3 / $15 per million
	if err != nil {
		t.Fatal(err)
	}
	for _, stream := range []bool{false, true} {
		t.Run(fmt.Sprintf("stream=%v", stream), func(t *testing.T) {
			c := &capLog{full: 8192}
			r := newRigWith(t, c.handler(), orchestrator.Options{Prices: tab, Stream: stream})
			pid := r.project(t, 1)
			r.update(t, pid, budgetInput(0.0005))
			if st := r.run(t, pid, "write a long essay", nil); st != "failed" {
				t.Fatalf("turn = %s, want failed", st)
			}
			c.mu.Lock()
			got := c.max
			c.mu.Unlock()
			// $0.0005 buys 33 output tokens at $15/M: the floor (256) is asked for.
			if len(got) != 1 || got[0] != 256 {
				t.Fatalf("max_tokens asked = %v, want [256]", got)
			}
			orch, msgs := orchMessages(t, r, pid)
			if orch.Error == nil || !strings.Contains(*orch.Error, "budget ran out during this request") || !strings.Contains(*orch.Error, "stopped mid-request") {
				t.Fatalf("orchestrator error = %v", orch.Error)
			}
			if len(msgs) != 2 || msgs[1].Role != "assistant" || !msgs[1].Stopped || *msgs[1].Content[0].Text != "The essay begins here" {
				t.Fatalf("messages = %+v", msgs)
			}
			x := onlyExchange(t, r, pid)
			if x.Error == nil || x.Error.Code != usererr.CodeBudgetReached || x.KeptText == nil || !*x.KeptText {
				t.Fatalf("exchange = %+v", x)
			}
			// The next request is refused before it is sent: the budget is spent.
			if st := r.run(t, pid, "more", nil); st != "failed" {
				t.Fatal(st)
			}
			if c.mu.Lock(); len(c.max) != 1 {
				t.Fatalf("a request went out over budget: %v", c.max)
			}
			c.mu.Unlock()
		})
	}
}

// P2-11: a budget with room asks for what it can buy, and without a budget (or a price) nothing is capped.
func TestBudgetCapScalesWithWhatIsLeft(t *testing.T) {
	model := config.BuiltinModels().Orchestrator
	tab, err := prices.Parse(fmt.Sprintf("[models.%q]\ninput = 3\noutput = 15\n", model))
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		budget *float64
		prices prices.Table
		lo, hi int64
	}{
		{"a budget with some room asks for what it buys after the input", usdPtr(0.1), tab, 257, 8191},
		{"a large budget does not lower the default", usdPtr(100.0), tab, 8192, 8192},
		{"no budget", nil, tab, 8192, 8192},
		{"no price", usdPtr(0.0005), prices.Table{}, 8192, 8192},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := &capLog{full: 1} // always ends normally
			r := newRigWith(t, c.handler(), orchestrator.Options{Prices: tc.prices})
			pid := r.project(t, 1)
			if tc.budget != nil {
				r.update(t, pid, budgetInput(*tc.budget))
			}
			if st := r.run(t, pid, "hello", nil); st != "completed" {
				t.Fatalf("turn = %s", st)
			}
			c.mu.Lock()
			defer c.mu.Unlock()
			if len(c.max) != 1 || c.max[0] < tc.lo || c.max[0] > tc.hi {
				t.Fatalf("max_tokens = %v, want within [%d, %d]", c.max, tc.lo, tc.hi)
			}
		})
	}
}

func usdPtr(v float64) *float64 { return &v }
