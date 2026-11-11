package bridge_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/bridge"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakerouter"
	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/router"
)

func routeStack(t *testing.T, script fakerouter.RouteScript) (*fakerouter.Router, *router.Router) {
	t.Helper()
	fr := fakerouter.New(mockllm.New(0), fakerouter.Options{Route: &script})
	srv := httptest.NewServer(fr)
	t.Cleanup(srv.Close)
	return fr, router.New(context.Background(), srv.URL, "")
}

// An ACP orchestrator's spawn_agent over MCP offers tier auto, and the router's
// choice of an ACP agent starts that agent.
func TestMCPSpawnAutoRoutesToACPAgent(t *testing.T) {
	fr, octo := routeStack(t, fakerouter.RouteScript{Choice: "acp:scripted", Band: "medium", Reason: "flat-rate agent fits"})
	e := newACPEnv(t, nil, func(o *orchestrator.Options) { o.Router = octo }, bridge.WithRouter(octo))

	var cfg struct {
		RouteAPI bool `json:"route_api"`
	}
	e.into(t, "GET", "/v1/config", nil, http.StatusOK, &cfg)
	if !cfg.RouteAPI {
		t.Fatal("GET /v1/config route_api = false with a router that announces it")
	}

	p := e.acpProject(t)
	tr := e.ask(t, p, "[mcp-spawn] look around")
	if tr.status != "completed" {
		t.Fatalf("turn = %s (%v)", tr.status, tr.errMsg)
	}
	var sub *apiAgentFull
	for _, a := range e.agents(t, p) {
		if a.ParentID != nil {
			a := a
			sub = &a
		}
	}
	if sub == nil || sub.Model != "acp:scripted" || sub.Status != "completed" {
		t.Fatalf("sub-agent = %+v", sub)
	}
	if sub.RouteChoice == nil || *sub.RouteChoice != "acp:scripted" || sub.RouteReason == nil ||
		*sub.RouteReason != "flat-rate agent fits" || sub.RouteBand == nil || *sub.RouteBand != "medium" {
		t.Fatalf("route fields = %+v", sub)
	}
	seen := fr.RouteRequests()
	if len(seen) != 1 || !strings.Contains(string(seen[0].Body), `"id":"acp:scripted"`) {
		t.Fatalf("route requests = %d", len(seen))
	}
}

// With the built-in loop unavailable and a router that does not answer, auto
// falls back to the first ready ACP agent, never failing the call.
func TestMCPSpawnAutoFallsBackToACPAgentWithoutBuiltinLoop(t *testing.T) {
	_, octo := routeStack(t, fakerouter.RouteScript{Status: 503})
	e := newACPEnv(t, nil, func(o *orchestrator.Options) {
		o.Router, o.BuiltinUnavailable = octo, "no key"
	}, bridge.WithRouter(octo))
	p := e.acpProject(t)
	tr := e.ask(t, p, "[mcp-spawn] look around")
	if tr.status != "completed" {
		t.Fatalf("turn = %s (%v)", tr.status, tr.errMsg)
	}
	for _, a := range e.agents(t, p) {
		if a.ParentID == nil {
			continue
		}
		if a.Model != "acp:scripted" || a.RouteReason == nil || !strings.Contains(*a.RouteReason, "router did not answer") ||
			a.RouteChoice == nil || *a.RouteChoice != "acp:scripted" || a.RouteBand != nil {
			t.Fatalf("sub-agent = %+v", a)
		}
		return
	}
	t.Fatal("no sub-agent")
}
