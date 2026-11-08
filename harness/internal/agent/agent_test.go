package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/ndolinschi/Octo/harness/internal/anthropicclient"
	"github.com/ndolinschi/Octo/harness/internal/store"
	"github.com/ndolinschi/Octo/harness/internal/tools"
)

func TestRunner_ToolRoundTrip(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/messages" {
			http.Error(w, "unexpected request", http.StatusNotFound)
			return
		}
		n := calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		switch n {
		case 1:
			_, _ = fmt.Fprint(w, `{
				"id":"msg_1","type":"message","role":"assistant",
				"content":[{"type":"tool_use","id":"toolu_echo","name":"echo","input":{"text":"ping"}}],
				"model":"claude-test","stop_reason":"tool_use",
				"usage":{"input_tokens":1,"output_tokens":1}
			}`)
		case 2:
			_, _ = fmt.Fprint(w, `{
				"id":"msg_2","type":"message","role":"assistant",
				"content":[{"type":"text","text":"done"}],
				"model":"claude-test","stop_reason":"end_turn",
				"usage":{"input_tokens":1,"output_tokens":1}
			}`)
		default:
			http.Error(w, "too many calls", http.StatusInternalServerError)
		}
	}))
	t.Cleanup(srv.Close)

	ctx := context.Background()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	reg := tools.NewRegistry()
	if err := reg.Register(tools.Def{
		Name:        "echo",
		Description: "echo input",
		InputSchema: json.RawMessage(`{"type":"object","properties":{"text":{"type":"string"}}}`),
		Handle: func(ctx context.Context, input json.RawMessage) (string, bool, error) {
			return "pong", false, nil
		},
	}); err != nil {
		t.Fatalf("Register: %v", err)
	}

	client := anthropicclient.New("test-key", srv.URL)
	r := &Runner{
		Client:   client,
		Registry: reg,
		Store:    st,
		Model:    "claude-test",
		MaxTurns: 10,
	}

	sessionID, finalText, err := r.Run(ctx, "start")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !strings.Contains(finalText, "done") {
		t.Fatalf("finalText = %q, want substring done", finalText)
	}

	n, err := st.MessageCount(ctx, sessionID)
	if err != nil {
		t.Fatalf("MessageCount: %v", err)
	}
	if n < 3 {
		t.Fatalf("MessageCount = %d, want >= 3", n)
	}
	if calls.Load() != 2 {
		t.Fatalf("API calls = %d, want 2", calls.Load())
	}
}
