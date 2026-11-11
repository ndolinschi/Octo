package anthropicclient_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/ndolinschi/Octo/apps/harness/internal/anthropicclient"
	"github.com/ndolinschi/Octo/apps/harness/internal/config"
)

// WithKeyFunc makes each request carry the key at that moment, not the one New
// was given: a key written to the settings file reaches a running client.
func TestKeyFuncSendsTheCurrentKey(t *testing.T) {
	var mu sync.Mutex
	var got []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		got = append(got, r.Header.Get("Authorization")+"|"+r.Header.Get("X-Api-Key"))
		mu.Unlock()
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"type":"error","error":{"type":"authentication_error","message":"no"}}`))
	}))
	defer srv.Close()
	keys := config.NewKeySource("")
	c := anthropicclient.New("", srv.URL, "", anthropicclient.WithKeyFunc(keys.Get))
	ask := func() {
		_, _ = c.Messages.New(context.Background(), anthropic.MessageNewParams{
			Model: "m", MaxTokens: 8, Messages: []anthropic.MessageParam{anthropic.NewUserMessage(anthropic.NewTextBlock("hi"))},
		})
	}
	ask() // no key yet: the request goes out as the SDK built it
	keys.Set("sk-first")
	ask()
	keys.Set("sk-second")
	ask()
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 3 {
		t.Fatalf("requests = %q", got)
	}
	for i, want := range []string{"sk-first", "sk-second"} {
		if !strings.Contains(got[i+1], want) || strings.Contains(got[i+1], "sk-first") && want == "sk-second" {
			t.Fatalf("request %d carried %q, want the key %q", i+1, got[i+1], want)
		}
	}
}

func TestKeySource(t *testing.T) {
	var nilSource *config.KeySource
	if nilSource.Get() != "" {
		t.Fatal("a nil source has no key")
	}
	k := config.NewKeySource("a")
	if k.Get() != "a" {
		t.Fatal("initial key")
	}
	k.Set("")
	if k.Get() != "" {
		t.Fatal("cleared key")
	}
}
