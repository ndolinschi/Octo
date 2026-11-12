package bridge_test

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/bridge"
)

const testToken = "test-token-0123456789abcdef"

func tokenEnv(t *testing.T) *env {
	t.Helper()
	mcpStub := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="octo-harness-mcp"`)
		http.Error(w, "missing or invalid token", http.StatusUnauthorized)
	})
	return newEnvWith(t, nil, nil, bridge.WithAPIToken(testToken), bridge.WithMCP(mcpStub), bridge.WithPingInterval(50*time.Millisecond))
}

func (e *env) raw(t *testing.T, method, path string, hdr map[string]string, body string) (*http.Response, []byte) {
	t.Helper()
	req, err := http.NewRequest(method, e.url+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, b
}

func bearer(tok string) map[string]string { return map[string]string{"Authorization": "Bearer " + tok} }

func TestAPITokenEveryV1RouteNeedsTheToken(t *testing.T) {
	e := tokenEnv(t)
	routes := []struct{ method, path string }{
		{"GET", "/v1/config"}, {"GET", "/v1/projects"}, {"POST", "/v1/projects"},
		{"GET", "/v1/projects/p1"}, {"DELETE", "/v1/projects/p1"},
		{"GET", "/v1/projects/p1/events"},
		{"POST", "/v1/projects/p1/approvals/a1"}, {"POST", "/v1/projects/p1/inputs/i1"},
		{"PUT", "/v1/projects/p1/secrets/NAME"}, {"GET", "/v1/projects/p1/files/content?path=a"},
		{"PUT", "/v1/projects/p1/files/content"}, {"POST", "/v1/projects/p1/reviews/r1/submit"},
		{"POST", "/v1/projects/p1/lsp/go/sessions"}, {"GET", "/v1/projects/p1/lsp/sessions/s1/events"},
		{"GET", "/v1/settings"}, {"GET", "/v1/diagnostics"}, {"GET", "/v1/no/such/route"},
	}
	for _, rt := range routes {
		resp, body := e.raw(t, rt.method, rt.path, nil, "{}")
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s %s without a token = %d, want 401: %s", rt.method, rt.path, resp.StatusCode, body)
			continue
		}
		var out struct {
			Error struct{ Code, Message string }
		}
		if err := json.Unmarshal(body, &out); err != nil || out.Error.Code != "unauthorized" || !strings.Contains(out.Error.Message, "Authorization: Bearer") {
			t.Errorf("%s %s body = %s", rt.method, rt.path, body)
		}
		if resp.Header.Get("WWW-Authenticate") == "" || resp.Header.Get("Content-Type") != "application/json" {
			t.Errorf("%s %s headers = %v", rt.method, rt.path, resp.Header)
		}
		if strings.Contains(string(body), testToken) {
			t.Errorf("%s %s echoed the token", rt.method, rt.path)
		}
	}
}

func TestAPITokenWrongCredentialsAreRefused(t *testing.T) {
	e := tokenEnv(t)
	for name, hdr := range map[string]map[string]string{
		"wrong token":       bearer("not-the-token-0123456789"),
		"prefix of token":   bearer(testToken[:len(testToken)-1]),
		"token plus suffix": bearer(testToken + "x"),
		"empty bearer":      {"Authorization": "Bearer "},
		"basic scheme":      {"Authorization": "Basic " + testToken},
		"bare token":        {"Authorization": testToken},
		"other header":      {"X-Api-Token": testToken},
	} {
		if resp, body := e.raw(t, "GET", "/v1/projects", hdr, ""); resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s = %d: %s", name, resp.StatusCode, body)
		}
	}
	// The query parameter is not a way in on an ordinary route.
	if resp, _ := e.raw(t, "GET", "/v1/projects?token="+testToken, nil, ""); resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("?token= on /v1/projects = %d, want 401", resp.StatusCode)
	}
	// A wrong header is not rescued by a right query parameter.
	if resp, _ := e.raw(t, "GET", "/v1/projects/p1/events?token="+testToken, bearer("wrong-token-0123456789"), ""); resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("wrong header + right query = %d, want 401", resp.StatusCode)
	}
	// Only GET on the SSE routes takes the query parameter.
	if resp, _ := e.raw(t, "POST", "/v1/projects/p1/events?token="+testToken, nil, "{}"); resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("POST events with ?token= = %d, want 401", resp.StatusCode)
	}
	if resp, _ := e.raw(t, "GET", "/v1/projects/p1/events/extra?token="+testToken, nil, ""); resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("GET events/extra with ?token= = %d, want 401", resp.StatusCode)
	}
	if resp, _ := e.raw(t, "GET", "/v1/projects/p1/events?token=wrong-token-0123456789", nil, ""); resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("SSE with a wrong ?token= = %d, want 401", resp.StatusCode)
	}
}

func TestAPITokenAcceptsTheTokenAndKeepsTheRestOpen(t *testing.T) {
	e := tokenEnv(t)
	for _, h := range []map[string]string{bearer(testToken), {"Authorization": "bearer " + testToken}} {
		if resp, body := e.raw(t, "GET", "/v1/projects", h, ""); resp.StatusCode != http.StatusOK {
			t.Fatalf("GET /v1/projects with the token = %d: %s", resp.StatusCode, body)
		}
	}
	// An unknown /v1 route is the router's 404 once past the check.
	if resp, _ := e.raw(t, "GET", "/v1/no/such/route", bearer(testToken), ""); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown route with the token = %d, want 404", resp.StatusCode)
	}
	// /health is open.
	if resp, body := e.raw(t, "GET", "/health", nil, ""); resp.StatusCode != http.StatusOK {
		t.Fatalf("/health = %d: %s", resp.StatusCode, body)
	}
	// A CORS preflight (no credentials by design) is answered and allows the header.
	resp, _ := e.raw(t, "OPTIONS", "/v1/projects", map[string]string{
		"Origin": "http://localhost:1420", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization",
	}, "")
	if resp.StatusCode != http.StatusNoContent || !strings.Contains(resp.Header.Get("Access-Control-Allow-Headers"), "Authorization") {
		t.Fatalf("preflight = %d %v", resp.StatusCode, resp.Header)
	}
	// The MCP routes keep their own per-session tokens: the API token is neither
	// required nor accepted there.
	resp, _ = e.raw(t, "POST", "/mcp/v1/projects/p1", bearer(testToken), "{}")
	if resp.StatusCode != http.StatusUnauthorized || !strings.Contains(resp.Header.Get("WWW-Authenticate"), "octo-harness-mcp") {
		t.Fatalf("MCP route with the API token = %d %v", resp.StatusCode, resp.Header)
	}
}

func TestAPITokenSSEAcceptsTheQueryParameter(t *testing.T) {
	e := tokenEnv(t)
	var p struct{ ID string }
	req, _ := http.NewRequest("POST", e.url+"/v1/projects", strings.NewReader(`{"name":"sse"}`))
	req.Header.Set("Authorization", "Bearer "+testToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create = %d", resp.StatusCode)
	}
	_ = json.NewDecoder(resp.Body).Decode(&p)
	resp.Body.Close()

	for name, tc := range map[string]struct {
		url string
		hdr string
	}{"query": {e.url + "/v1/projects/" + p.ID + "/events?token=" + testToken, ""}, "header": {e.url + "/v1/projects/" + p.ID + "/events", "Bearer " + testToken}} {
		req, _ := http.NewRequest("GET", tc.url, nil)
		if tc.hdr != "" {
			req.Header.Set("Authorization", tc.hdr)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		buf := make([]byte, 64)
		n, _ := resp.Body.Read(buf)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") || !strings.Contains(string(buf[:n]), ": connected") {
			t.Fatalf("%s: SSE = %d %q", name, resp.StatusCode, buf[:n])
		}
	}
}

func TestNoTokenConfiguredLeavesTheBridgeOpen(t *testing.T) {
	e := newEnv(t, nil)
	if resp, body := e.raw(t, "GET", "/v1/projects", nil, ""); resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /v1/projects without a token configured = %d: %s", resp.StatusCode, body)
	}
}
