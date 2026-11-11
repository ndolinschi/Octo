package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/ndolinschi/Octo/apps/harness/internal/anthropicclient"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
)

type recSink struct {
	mu       sync.Mutex
	roles    []string
	started  []string
	finished []string
	usage    Usage
}

func (s *recSink) Message(_ context.Context, role string, _ anthropic.MessageParam) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.roles = append(s.roles, role)
	return nil
}
func (s *recSink) TextDelta(string) {}
func (s *recSink) ToolStarted(id, _ string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.started = append(s.started, id)
}
func (s *recSink) ToolFinished(id string, _ bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.finished = append(s.finished, id)
}
func (s *recSink) Usage(u Usage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.usage.add(u)
}

func TestLoop_ParallelToolsKeepOrderAndSystemPrompt(t *testing.T) {
	var calls atomic.Int32
	var gotSystem atomic.Value
	var resultOrder atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			System   []struct{ Text string } `json:"system"`
			Messages []struct {
				Content []struct {
					Type      string `json:"type"`
					ToolUseID string `json:"tool_use_id"`
				}
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if calls.Add(1) == 1 {
			gotSystem.Store(body.System[0].Text)
			fmt.Fprint(w, `{"id":"m","type":"message","role":"assistant","model":"x","stop_reason":"tool_use",
				"content":[{"type":"tool_use","id":"t1","name":"slow","input":{}},{"type":"tool_use","id":"t2","name":"fast","input":{}}],
				"usage":{"input_tokens":10,"output_tokens":4}}`)
			return
		}
		var ids []string
		for _, b := range body.Messages[len(body.Messages)-1].Content {
			ids = append(ids, b.ToolUseID)
		}
		resultOrder.Store(strings.Join(ids, ","))
		fmt.Fprint(w, `{"id":"m","type":"message","role":"assistant","model":"x","stop_reason":"end_turn",
			"content":[{"type":"text","text":"fin"}],"usage":{"input_tokens":20,"output_tokens":6}}`)
	}))
	t.Cleanup(srv.Close)

	fastDone := make(chan struct{})
	reg := tools.NewRegistry()
	for name, h := range map[string]tools.Handler{
		"slow": func(ctx context.Context, _ json.RawMessage) (string, bool, error) {
			select {
			case <-fastDone:
				return "slow-out", false, nil
			case <-time.After(5 * time.Second):
				return "serial execution detected", true, nil
			}
		},
		"fast": func(ctx context.Context, _ json.RawMessage) (string, bool, error) {
			if id := tools.ToolUseID(ctx); id != "t2" {
				return "wrong tool_use id " + id, true, nil
			}
			close(fastDone)
			return "fast-out", false, nil
		},
	} {
		if err := reg.Register(tools.Def{Name: name, Handle: h}); err != nil {
			t.Fatal(err)
		}
	}

	sink := &recSink{}
	loop := Loop{
		Client: anthropicclient.New("k", srv.URL, ""), Registry: reg, Model: "m",
		System: "be brief", SessionID: "s", Sink: sink,
	}
	hist := []anthropic.MessageParam{anthropic.NewUserMessage(anthropic.NewTextBlock("go"))}
	res, err := loop.Run(context.Background(), hist)
	if err != nil {
		t.Fatal(err)
	}
	if res.Text != "fin" || res.Usage.InputTokens != 30 || res.Usage.OutputTokens != 10 || sink.usage != res.Usage {
		t.Fatalf("result = %+v sink usage = %+v", res, sink.usage)
	}
	if got := resultOrder.Load(); got != "t1,t2" {
		t.Fatalf("tool_result order = %v, want t1,t2", got)
	}
	if gotSystem.Load() != "be brief" {
		t.Fatalf("system = %v", gotSystem.Load())
	}
	if strings.Join(sink.roles, ",") != "assistant,user,assistant" || len(sink.started) != 2 || len(sink.finished) != 2 {
		t.Fatalf("sink = %+v", sink)
	}
}

func TestLoop_CancelledContextStopsBeforeCall(t *testing.T) {
	loop := Loop{Registry: tools.NewRegistry(), Model: "m", Sink: &recSink{}}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := loop.Run(ctx, []anthropic.MessageParam{anthropic.NewUserMessage(anthropic.NewTextBlock("x"))})
	if err != context.Canceled {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}
