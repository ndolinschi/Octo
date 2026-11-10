package anthropicclient_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/ndolinschi/Octo/apps/harness/internal/anthropicclient"
)

type seen struct {
	host, model, remaining string
}

func TestObserverSeesHostModelAndHeaders(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
	}{{"success", http.StatusOK}, {"rate limited", http.StatusTooManyRequests}} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("anthropic-ratelimit-requests-remaining", "41")
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.status)
				if tc.status == http.StatusOK {
					_, _ = w.Write([]byte(`{"id":"m","type":"message","role":"assistant","model":"x","content":[],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}`))
					return
				}
				_, _ = w.Write([]byte(`{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}`))
			}))
			defer srv.Close()
			u, err := url.Parse(srv.URL)
			if err != nil {
				t.Fatal(err)
			}

			var mu sync.Mutex
			var got []seen
			c := anthropicclient.New("k", srv.URL, "", anthropicclient.WithResponseObserver(func(host, model string, h http.Header) {
				mu.Lock()
				defer mu.Unlock()
				got = append(got, seen{host, model, h.Get("anthropic-ratelimit-requests-remaining")})
			}))
			_, _ = c.Messages.New(context.Background(), anthropic.MessageNewParams{
				Model: "claude-test", MaxTokens: 8, Messages: []anthropic.MessageParam{anthropic.NewUserMessage(anthropic.NewTextBlock("hi"))},
			})
			mu.Lock()
			defer mu.Unlock()
			if len(got) == 0 {
				t.Fatal("observer not called")
			}
			want := seen{u.Host, "claude-test", "41"}
			if got[0] != want {
				t.Fatalf("observed %+v, want %+v", got[0], want)
			}
		})
	}
}
