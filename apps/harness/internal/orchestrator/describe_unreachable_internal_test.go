package orchestrator

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"syscall"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/router"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// A model service that stopped (refused, reset, cut mid-answer) is a broken
// connection in plain words, not "Something went wrong inside Octo"; through
// the Octo router it names the router.
func TestDescribeBrokenModelConnection(t *testing.T) {
	octo := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"service":"octo","capabilities":[]}`))
	}))
	defer octo.Close()
	detected := router.New(context.Background(), octo.URL, "")
	notRouter := router.New(context.Background(), "", "")
	refused := &url.Error{Op: "Post", URL: "http://127.0.0.1:8090/v1/messages", Err: &net.OpError{Op: "dial", Net: "tcp", Err: syscall.ECONNREFUSED}}
	for name, err := range map[string]error{
		"cut mid-answer": fmt.Errorf("stream: %w", io.ErrUnexpectedEOF),
		"refused":        refused,
		"reset":          fmt.Errorf("read: %w", syscall.ECONNRESET),
	} {
		if got := describe(err); got.Code != "model_unreachable" || got.Details == "" {
			t.Errorf("%s: describe = %+v", name, got)
		}
		if got := (&Orchestrator{opts: Options{Router: notRouter}}).describeTurn(err); got.Code != "model_unreachable" {
			t.Errorf("%s without a router: %q", name, got.Code)
		}
		viaRouter := &Orchestrator{opts: Options{Router: detected}}
		if got := viaRouter.describeTurn(err); got.Code != "router_unreachable" || got.Message != "The Octo router stopped answering." {
			t.Errorf("%s via the router: %+v", name, got)
		}
	}
	if got := describe(errors.New("boom")); got.Code != usererr.CodeUnexpected {
		t.Errorf("an unknown error: %q", got.Code)
	}
}
