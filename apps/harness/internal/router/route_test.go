package router_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/router"
)

func routeServer(t *testing.T, h http.HandlerFunc) *router.Router {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			_, _ = w.Write([]byte(`{"service":"octo","capabilities":["route_api"]}`))
			return
		}
		h(w, r)
	}))
	t.Cleanup(srv.Close)
	return router.New(context.Background(), srv.URL+"/autoroute", "okey", router.WithAPIKey("sk"), router.WithRouteTimeout(150*time.Millisecond))
}

func TestRouteSendsRequestAndParsesAnswer(t *testing.T) {
	var got map[string]any
	var hdr http.Header
	r := routeServer(t, func(w http.ResponseWriter, req *http.Request) {
		hdr = req.Header.Clone()
		_ = json.NewDecoder(req.Body).Decode(&got)
		_, _ = w.Write([]byte(`{"choice":"fast","model":"slug","band":"easy","reason":"r","estimated_cost_usd":null,"alternatives":[],"request_id":"octo_1"}`))
	})
	if !r.Has(router.CapRouteAPI) {
		t.Fatal("capability not detected")
	}
	d, err := r.Route(context.Background(), router.RouteRequest{BudgetKey: "p1",
		Task:       router.RouteTask{Title: "t", Tools: []string{"a"}, Depth: 1},
		Candidates: []router.Candidate{{ID: "fast", Kind: "api", Tier: "fast"}}})
	if err != nil || d.Choice != "fast" || d.Band != "easy" || d.RequestID != "octo_1" || d.Model != "slug" {
		t.Fatalf("decision = %+v, %v", d, err)
	}
	if got["budget_key"] != "p1" || hdr.Get("x-octo-key") != "okey" || hdr.Get("x-api-key") != "sk" || hdr.Get("x-octo-budget-key") != "p1" {
		t.Fatalf("request body %v headers %v", got, hdr)
	}
}

func TestRouteErrorKinds(t *testing.T) {
	for _, tc := range []struct {
		status int
		kind   router.RouteFailure
	}{
		{402, router.RouteBudget}, {422, router.RouteNoCandidate}, {503, router.RouteUnavailable},
		{500, router.RouteUnavailable}, {400, router.RouteRejected},
	} {
		r := routeServer(t, func(w http.ResponseWriter, req *http.Request) {
			w.WriteHeader(tc.status)
			_, _ = w.Write([]byte(`{"type":"error","error":{"type":"x","message":"boom"}}`))
		})
		_, err := r.Route(context.Background(), router.RouteRequest{})
		var re *router.RouteError
		if !errors.As(err, &re) || re.Kind != tc.kind || re.Status != tc.status || re.Msg != "boom" {
			t.Errorf("status %d: err = %v", tc.status, err)
		}
	}
	// Timeout and garbage answers are "did not answer".
	r := routeServer(t, func(w http.ResponseWriter, req *http.Request) { time.Sleep(400 * time.Millisecond) })
	var re *router.RouteError
	if _, err := r.Route(context.Background(), router.RouteRequest{}); !errors.As(err, &re) || re.Kind != router.RouteUnavailable {
		t.Errorf("timeout: %v", err)
	}
	r = routeServer(t, func(w http.ResponseWriter, req *http.Request) { _, _ = w.Write([]byte(`{"choice":""}`)) })
	if _, err := r.Route(context.Background(), router.RouteRequest{}); !errors.As(err, &re) || re.Kind != router.RouteUnavailable {
		t.Errorf("empty choice: %v", err)
	}
	var nilRouter *router.Router
	if _, err := nilRouter.Route(context.Background(), router.RouteRequest{}); err == nil {
		t.Error("nil router must fail, not panic")
	}
}
