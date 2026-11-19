package router

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The version the router announces on /health is kept for GET /health of the harness (the About page).
func TestVersionFromHealth(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"ok","service":"octo","version":"0.2.0","capabilities":[]}`))
	}))
	defer srv.Close()
	r := New(context.Background(), srv.URL, "")
	if !r.Enabled() || r.Version() != "0.2.0" {
		t.Fatalf("enabled=%v version=%q", r.Enabled(), r.Version())
	}
	var none *Router
	if none.Version() != "" {
		t.Fatal("nil router has a version")
	}
}
