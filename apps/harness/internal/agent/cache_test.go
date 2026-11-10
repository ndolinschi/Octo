package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/ndolinschi/Octo/apps/harness/internal/anthropicclient"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
)

// capture serves scripted replies and keeps every request body.
type capture struct {
	mu     sync.Mutex
	bodies [][]byte
}

func (c *capture) handler(replies []string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		c.mu.Lock()
		n := len(c.bodies)
		c.bodies = append(c.bodies, body)
		c.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, replies[min(n, len(replies)-1)])
	})
}

func toolUseReply(i int, names ...string) string {
	var blocks []string
	for j, n := range names {
		blocks = append(blocks, fmt.Sprintf(`{"type":"tool_use","id":"toolu_%d_%d","name":%q,"input":{}}`, i, j, n))
	}
	return fmt.Sprintf(`{"id":"m%d","type":"message","role":"assistant","model":"x","stop_reason":"tool_use","content":[%s],"usage":{"input_tokens":5,"output_tokens":5}}`,
		i, strings.Join(blocks, ","))
}

const finalReply = `{"id":"mf","type":"message","role":"assistant","model":"x","stop_reason":"end_turn","content":[{"type":"text","text":"done"}],"usage":{"input_tokens":5,"output_tokens":5}}`

// threeToolTurns is a 4-request script: two tool calls, one tool call, one
// call in a different order, then the answer.
func threeToolTurns() []string {
	return []string{toolUseReply(1, "zeta", "alpha"), toolUseReply(2, "alpha"), toolUseReply(3, "mid"), finalReply}
}

func testRegistry(t *testing.T, names ...string) *tools.Registry {
	t.Helper()
	reg := tools.NewRegistry()
	for _, n := range names {
		err := reg.Register(tools.Def{
			Name: n, Description: "tool " + n,
			InputSchema: json.RawMessage(`{"type":"object","properties":{"q":{"type":"string"}}}`),
			Handle: func(context.Context, json.RawMessage) (string, bool, error) {
				return "result of " + n + strings.Repeat(" more", 20), false, nil
			},
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	return reg
}

// keepSink keeps the marshalled messages the loop persists.
type keepSink struct {
	recSink
	stored [][]byte
}

func (s *keepSink) Message(ctx context.Context, role string, m anthropic.MessageParam) error {
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.stored = append(s.stored, b)
	s.mu.Unlock()
	return s.recSink.Message(ctx, role, m)
}

type wireRequest struct {
	System   []map[string]json.RawMessage `json:"system"`
	Tools    []map[string]json.RawMessage `json:"tools"`
	Messages []struct {
		Role    string                       `json:"role"`
		Content []map[string]json.RawMessage `json:"content"`
	} `json:"messages"`
}

func parseWire(t *testing.T, b []byte) wireRequest {
	t.Helper()
	var w wireRequest
	if err := json.Unmarshal(b, &w); err != nil {
		t.Fatal(err)
	}
	return w
}

const ephemeralJSON = `{"type":"ephemeral"}`

// breakpoints lists where a request carries cache_control, in cache order.
func breakpoints(w wireRequest) []string {
	var out []string
	has := func(m map[string]json.RawMessage) bool {
		v, ok := m["cache_control"]
		if ok && string(v) != ephemeralJSON {
			out = append(out, "BAD:"+string(v))
		}
		return ok
	}
	for i, m := range w.Tools {
		if has(m) {
			out = append(out, fmt.Sprintf("tool%d", i))
		}
	}
	for i, m := range w.System {
		if has(m) {
			out = append(out, fmt.Sprintf("system%d", i))
		}
	}
	for i, msg := range w.Messages {
		for j, m := range msg.Content {
			if has(m) {
				out = append(out, fmt.Sprintf("msg%d.%d", i, j))
			}
		}
	}
	return out
}

func runCaptured(t *testing.T, loop Loop, replies []string) (*capture, *keepSink, []anthropic.MessageParam) {
	t.Helper()
	c := &capture{}
	srv := httptest.NewServer(c.handler(replies))
	t.Cleanup(srv.Close)
	sink := &keepSink{}
	loop.Client = anthropicclient.New("k", srv.URL, "")
	loop.Model, loop.SessionID, loop.Sink = "m", "s", sink
	hist := []anthropic.MessageParam{anthropic.NewUserMessage(anthropic.NewTextBlock("go"))}
	if _, err := loop.Run(context.Background(), hist); err != nil {
		t.Fatal(err)
	}
	return c, sink, hist
}

func TestLoop_CacheBreakpoints(t *testing.T) {
	tests := []struct {
		name string
		loop func(t *testing.T) Loop
		// want gives the expected breakpoints for the request with n messages.
		want func(nMessages int) []string
	}{
		{
			name: "tools, system and last message block",
			loop: func(t *testing.T) Loop {
				return Loop{Registry: testRegistry(t, "zeta", "alpha", "mid"), System: "be brief"}
			},
			want: func(n int) []string {
				// Messages alternate user/assistant; the last is a user tool_result
				// message whose final block is marked (or the single text block).
				last := []string{"tool2", "system0"}
				switch n {
				case 1:
					return append(last, "msg0.0")
				case 3:
					return append(last, "msg2.1") // two parallel tool results
				default:
					return append(last, fmt.Sprintf("msg%d.0", n-1))
				}
			},
		},
		{
			name: "no system prompt",
			loop: func(t *testing.T) Loop { return Loop{Registry: testRegistry(t, "zeta", "alpha", "mid")} },
			want: func(n int) []string {
				if n == 3 {
					return []string{"tool2", "msg2.1"}
				}
				return []string{"tool2", fmt.Sprintf("msg%d.0", n-1)}
			},
		},
		{
			name: "caching off",
			loop: func(t *testing.T) Loop {
				return Loop{Registry: testRegistry(t, "zeta", "alpha", "mid"), System: "be brief", NoPromptCaching: true}
			},
			want: func(int) []string { return nil },
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c, sink, hist := runCaptured(t, tc.loop(t), threeToolTurns())
			if len(c.bodies) != 4 {
				t.Fatalf("requests = %d, want 4", len(c.bodies))
			}
			for i, body := range c.bodies {
				w := parseWire(t, body)
				got := breakpoints(w)
				if len(got) > 4 {
					t.Errorf("request %d has %d breakpoints, max is 4", i, len(got))
				}
				if want := tc.want(len(w.Messages)); strings.Join(got, ",") != strings.Join(want, ",") {
					t.Errorf("request %d (%d messages): breakpoints %v, want %v", i, len(w.Messages), got, want)
				}
			}
			// What the loop persists, and the caller's history, never carry the marker.
			for i, m := range sink.stored {
				if bytes.Contains(m, []byte("cache_control")) {
					t.Errorf("stored message %d contains cache_control: %s", i, m)
				}
			}
			if b, _ := json.Marshal(hist); bytes.Contains(b, []byte("cache_control")) {
				t.Errorf("caller history was mutated: %s", b)
			}
		})
	}
}

// TestLoop_PrefixStable checks the request prefix (tools, system, then each
// message) of request N+1 equals request N's, ignoring the breakpoint markers
// themselves: the only change between requests is appended messages.
func TestLoop_PrefixStable(t *testing.T) {
	c, _, _ := runCaptured(t, Loop{Registry: testRegistry(t, "zeta", "alpha", "mid"), System: "be brief"}, threeToolTurns())
	type parts struct {
		tools, system string
		messages      []string
	}
	split := func(b []byte) parts {
		var raw struct {
			Tools    []json.RawMessage `json:"tools"`
			System   []json.RawMessage `json:"system"`
			Messages []json.RawMessage `json:"messages"`
		}
		if err := json.Unmarshal(b, &raw); err != nil {
			t.Fatal(err)
		}
		strip := func(r json.RawMessage) string {
			return strings.ReplaceAll(string(r), `,"cache_control":{"type":"ephemeral"}`, "")
		}
		var p parts
		for _, x := range raw.Tools {
			p.tools += strip(x)
		}
		for _, x := range raw.System {
			p.system += strip(x)
		}
		for _, x := range raw.Messages {
			p.messages = append(p.messages, strip(x))
		}
		return p
	}
	// The markers' own JSON must be exactly the stripped form, or the check above proves nothing.
	if !bytes.Contains(c.bodies[0], []byte(`,"cache_control":{"type":"ephemeral"}`)) {
		t.Fatalf("breakpoint JSON is not in the expected shape: %s", c.bodies[0])
	}
	// Tools sorted by name, whatever the registration order.
	if p := split(c.bodies[0]); strings.Index(p.tools, `"alpha"`) > strings.Index(p.tools, `"mid"`) || strings.Index(p.tools, `"mid"`) > strings.Index(p.tools, `"zeta"`) {
		t.Fatalf("tools not sorted by name: %s", p.tools)
	}
	prev := split(c.bodies[0])
	for n := 1; n < len(c.bodies); n++ {
		cur := split(c.bodies[n])
		if cur.tools != prev.tools || cur.system != prev.system {
			t.Fatalf("request %d: tools or system changed", n)
		}
		if len(cur.messages) <= len(prev.messages) {
			t.Fatalf("request %d: %d messages after %d", n, len(cur.messages), len(prev.messages))
		}
		for i, m := range prev.messages {
			if cur.messages[i] != m {
				t.Fatalf("request %d: message %d changed:\n was %s\n now %s", n, i, m, cur.messages[i])
			}
		}
		prev = cur
	}
}

func TestWithMessageBreakpoint_SkipsUnmarkableBlocks(t *testing.T) {
	thinking := anthropic.ContentBlockParamUnion{OfThinking: &anthropic.ThinkingBlockParam{Thinking: "hm", Signature: "sig"}}
	tests := []struct {
		name string
		msgs []anthropic.MessageParam
		want string // "" = unchanged
	}{
		{"empty history", nil, ""},
		{"trailing thinking falls back to the text block", []anthropic.MessageParam{
			anthropic.NewAssistantMessage(anthropic.NewTextBlock("hello"), thinking)}, "0.0"},
		{"only an empty text block", []anthropic.MessageParam{
			anthropic.NewUserMessage(anthropic.NewTextBlock(""))}, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			before, _ := json.Marshal(tc.msgs)
			out := withMessageBreakpoint(tc.msgs)
			if after, _ := json.Marshal(tc.msgs); !bytes.Equal(before, after) {
				t.Fatalf("input mutated: %s", after)
			}
			var got []string
			for i, m := range out {
				for j, b := range ContentOf(m) {
					if cc := b.GetCacheControl(); cc != nil && cc.Type != "" {
						got = append(got, fmt.Sprintf("%d.%d", i, j))
					}
				}
			}
			if strings.Join(got, ",") != tc.want {
				t.Fatalf("marked %v, want %q", got, tc.want)
			}
		})
	}
}

func TestLoop_ToolResultCapped(t *testing.T) {
	reg := tools.NewRegistry()
	if err := reg.Register(tools.Def{Name: "big", Description: "d",
		Handle: func(context.Context, json.RawMessage) (string, bool, error) {
			return strings.Repeat("x", 300<<10), false, nil
		}}); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name string
		lim  tools.Limits
		max  int
	}{
		{"default 48 KiB", tools.Limits{}, 48 << 10},
		{"override", tools.Limits{ResultBytes: 4096}, 4096},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, sink, _ := runCaptured(t, Loop{Registry: reg, Limits: tc.lim}, []string{toolUseReply(1, "big"), finalReply})
			second := string(c.bodies[1])
			if len(second) > tc.max+2048 {
				t.Fatalf("second request is %d bytes; the result was not capped at %d", len(second), tc.max)
			}
			for _, want := range []string{"[truncated: showed the first", "of 307200 bytes", "read_file with offset/limit"} {
				if !strings.Contains(second, want) {
					t.Errorf("request lacks %q", want)
				}
			}
			// The persisted tool_result is the capped one too.
			if got := string(sink.stored[1]); len(got) > tc.max+1024 || !strings.Contains(got, "[truncated:") {
				t.Errorf("stored tool result is %d bytes", len(got))
			}
		})
	}
}
