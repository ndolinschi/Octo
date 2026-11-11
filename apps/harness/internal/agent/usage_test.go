package agent

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/ndolinschi/Octo/apps/harness/internal/anthropicclient"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
)

func sseEvent(w http.ResponseWriter, name, data string) {
	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", name, data)
}

func TestLoopReportsCacheTokensAndModel(t *testing.T) {
	const usageJSON = `"input_tokens":11,"output_tokens":7,"cache_read_input_tokens":300,"cache_creation_input_tokens":40`
	for _, stream := range []bool{false, true} {
		t.Run(fmt.Sprintf("stream=%v", stream), func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if !stream {
					w.Header().Set("Content-Type", "application/json")
					fmt.Fprintf(w, `{"id":"m","type":"message","role":"assistant","model":"x","stop_reason":"end_turn",
						"content":[{"type":"text","text":"ok"}],"usage":{%s}}`, usageJSON)
					return
				}
				w.Header().Set("Content-Type", "text/event-stream")
				sseEvent(w, "message_start", fmt.Sprintf(`{"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"x","content":[],"stop_reason":null,"stop_sequence":null,"usage":{%s}}}`, usageJSON))
				sseEvent(w, "content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`)
				sseEvent(w, "content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}`)
				sseEvent(w, "content_block_stop", `{"type":"content_block_stop","index":0}`)
				sseEvent(w, "message_delta", `{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":7}}`)
				sseEvent(w, "message_stop", `{"type":"message_stop"}`)
			}))
			t.Cleanup(srv.Close)

			sink := &recSink{}
			loop := Loop{
				Client: anthropicclient.New("k", srv.URL, ""), Registry: tools.NewRegistry(), Model: "claude-test",
				SessionID: "s", Sink: sink, Stream: stream,
			}
			res, err := loop.Run(context.Background(), []anthropic.MessageParam{anthropic.NewUserMessage(anthropic.NewTextBlock("go"))})
			if err != nil {
				t.Fatal(err)
			}
			want := Usage{InputTokens: 11, OutputTokens: 7, CacheReadTokens: 300, CacheWriteTokens: 40}
			if res.Usage != want || sink.usage != want {
				t.Fatalf("usage = %+v / sink %+v, want %+v", res.Usage, sink.usage, want)
			}
		})
	}
}
