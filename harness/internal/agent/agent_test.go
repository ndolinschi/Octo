package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
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
	var secondMsgCount atomic.Int32
	var secondHasToolResult atomic.Bool
	var sawSessionMeta atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/messages" {
			http.Error(w, "unexpected request", http.StatusNotFound)
			return
		}
		var body struct {
			Messages []json.RawMessage `json:"messages"`
			Metadata struct {
				UserID string `json:"user_id"`
			} `json:"metadata"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if strings.Contains(body.Metadata.UserID, `"session_id"`) {
			sawSessionMeta.Store(true)
		}
		n := calls.Add(1)
		if n == 2 {
			secondMsgCount.Store(int32(len(body.Messages)))
			for _, raw := range body.Messages {
				if strings.Contains(string(raw), `"type":"tool_result"`) || strings.Contains(string(raw), `"type": "tool_result"`) {
					secondHasToolResult.Store(true)
				}
			}
		}
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

	client := anthropicclient.New("test-key", srv.URL, "")
	r := &Runner{
		Client:   client,
		Registry: reg,
		Store:    st,
		Model:    "claude-test",
		MaxTurns: 10,
		Stream:   false,
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
	if secondMsgCount.Load() < 3 {
		t.Fatalf("second request messages = %d, want >= 3 (user + assistant tool_use + tool_result)", secondMsgCount.Load())
	}
	if !secondHasToolResult.Load() {
		t.Fatal("second request missing tool_result block")
	}
	if !sawSessionMeta.Load() {
		t.Fatal("request missing metadata.user_id session_id JSON")
	}
}

func TestRunner_SendsSessionMetadata(t *testing.T) {
	var gotUserID atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Metadata struct {
				UserID string `json:"user_id"`
			} `json:"metadata"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		gotUserID.Store(body.Metadata.UserID)
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{
			"id":"msg_1","type":"message","role":"assistant",
			"content":[{"type":"text","text":"ok"}],
			"model":"claude-test","stop_reason":"end_turn",
			"usage":{"input_tokens":1,"output_tokens":1}
		}`)
	}))
	t.Cleanup(srv.Close)

	ctx := context.Background()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	r := &Runner{
		Client:   anthropicclient.New("test-key", srv.URL, ""),
		Registry: tools.NewRegistry(),
		Store:    st,
		Model:    "claude-test",
		MaxTurns: 2,
		Stream:   false,
	}
	sessionID, _, err := r.Run(ctx, "hi")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	raw, _ := gotUserID.Load().(string)
	want := fmt.Sprintf(`{"session_id":%q}`, sessionID)
	if raw != want {
		t.Fatalf("metadata.user_id = %q, want %q", raw, want)
	}
}

func TestRunner_MaxTurnsExceeded(t *testing.T) {
	var toolCalls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/messages" {
			http.Error(w, "unexpected request", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{
			"id":"msg_1","type":"message","role":"assistant",
			"content":[{"type":"tool_use","id":"toolu_echo","name":"echo","input":{"text":"ping"}}],
			"model":"claude-test","stop_reason":"tool_use",
			"usage":{"input_tokens":1,"output_tokens":1}
		}`)
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
		Name: "echo",
		Handle: func(ctx context.Context, input json.RawMessage) (string, bool, error) {
			toolCalls.Add(1)
			return "pong", false, nil
		},
	}); err != nil {
		t.Fatalf("Register: %v", err)
	}

	client := anthropicclient.New("test-key", srv.URL, "")
	r := &Runner{
		Client:   client,
		Registry: reg,
		Store:    st,
		Model:    "claude-test",
		MaxTurns: 1,
		Stream:   false,
	}

	sessionID, _, err := r.Run(ctx, "start")
	if err == nil {
		t.Fatal("Run: expected error")
	}
	if !strings.Contains(err.Error(), "exceeded max turns") {
		t.Fatalf("Run err = %v, want exceeded max turns", err)
	}
	if sessionID == "" {
		t.Fatal("expected non-empty sessionID")
	}

	n, err := st.MessageCount(ctx, sessionID)
	if err != nil {
		t.Fatalf("MessageCount: %v", err)
	}
	if n != 2 {
		t.Fatalf("MessageCount = %d, want 2 (user + assistant)", n)
	}
	if toolCalls.Load() != 0 {
		t.Fatalf("echo invoked %d times, want 0", toolCalls.Load())
	}
}

func TestRunner_StreamingText(t *testing.T) {
	const sse = "event: message_start\n" +
		`data: {"type":"message_start","message":{"id":"msg_s","type":"message","role":"assistant","model":"claude-test","content":[],"usage":{"input_tokens":1,"output_tokens":1}}}` + "\n\n" +
		"event: content_block_start\n" +
		`data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}` + "\n\n" +
		"event: content_block_delta\n" +
		`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hel"}}` + "\n\n" +
		"event: content_block_delta\n" +
		`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}` + "\n\n" +
		"event: content_block_stop\n" +
		`data: {"type":"content_block_stop","index":0}` + "\n\n" +
		"event: message_delta\n" +
		`data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}` + "\n\n" +
		"event: message_stop\n" +
		`data: {"type":"message_stop"}` + "\n\n"

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/messages" {
			http.Error(w, "unexpected request", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, sse)
	}))
	t.Cleanup(srv.Close)

	ctx := context.Background()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	var streamBuf strings.Builder
	client := anthropicclient.New("test-key", srv.URL, "")
	r := &Runner{
		Client:    client,
		Registry:  tools.NewRegistry(),
		Store:     st,
		Model:     "claude-test",
		MaxTurns:  3,
		Stream:    true,
		StreamOut: &streamBuf,
	}

	sessionID, finalText, err := r.Run(ctx, "hi")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if finalText != "hello" {
		t.Fatalf("finalText = %q, want hello", finalText)
	}
	if streamBuf.String() != "hello" {
		t.Fatalf("streamed = %q, want hello", streamBuf.String())
	}
	n, err := st.MessageCount(ctx, sessionID)
	if err != nil {
		t.Fatalf("MessageCount: %v", err)
	}
	if n != 2 {
		t.Fatalf("MessageCount = %d, want 2 (user + assistant)", n)
	}
}
