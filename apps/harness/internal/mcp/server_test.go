package mcp_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/mcp"
)

type backend struct{ calls []string }

func (b *backend) Tools(mcp.Binding) ([]mcp.Tool, error) {
	return []mcp.Tool{{Name: "echo", Description: "d", InputSchema: json.RawMessage(`{"type":"object"}`)}}, nil
}

func (b *backend) Call(_ context.Context, bind mcp.Binding, name string, args json.RawMessage) (string, bool, error) {
	b.calls = append(b.calls, bind.ProjectID+"/"+name+string(args))
	switch name {
	case "echo":
		return "hi", false, nil
	case "fails":
		return "nope", true, nil
	}
	return "", false, mcp.ErrUnknownTool
}

func rig(t *testing.T) (*httptest.Server, *mcp.Tokens, *backend) {
	t.Helper()
	tokens, b := mcp.NewTokens(), &backend{}
	srv := httptest.NewServer(mcp.NewServer(tokens, b, "9.9"))
	t.Cleanup(srv.Close)
	return srv, tokens, b
}

func post(t *testing.T, url, token, body string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest("POST", url, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var sb strings.Builder
	buf := make([]byte, 4096)
	for {
		n, err := resp.Body.Read(buf)
		sb.Write(buf[:n])
		if err != nil {
			break
		}
	}
	return resp.StatusCode, sb.String()
}

func TestTokensAreRandomAndRevocable(t *testing.T) {
	tk := mcp.NewTokens()
	a := tk.Issue(mcp.Binding{ProjectID: "a", AgentID: "x"})
	b := tk.Issue(mcp.Binding{ProjectID: "b", AgentID: "y"})
	if a == b || len(a) != 64 {
		t.Fatalf("tokens %q %q", a, b)
	}
	if got, ok := tk.Lookup(a); !ok || got.ProjectID != "a" {
		t.Fatalf("lookup a = %+v %v", got, ok)
	}
	for _, bad := range []string{"", a[:63], a + "0", strings.ToUpper(a)} {
		if _, ok := tk.Lookup(bad); ok {
			t.Errorf("token %q must not resolve", bad)
		}
	}
	tk.Revoke(a)
	if _, ok := tk.Lookup(a); ok || tk.Live() != 1 {
		t.Errorf("revoked token still works (live %d)", tk.Live())
	}
}

func TestServerProtocol(t *testing.T) {
	srv, tokens, b := rig(t)
	tok := tokens.Issue(mcp.Binding{ProjectID: "p1", AgentID: "a1"})
	url := srv.URL + mcp.Path("p1")

	code, body := post(t, url, tok, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}`)
	if code != 200 || !strings.Contains(body, `"protocolVersion":"2025-03-26"`) || !strings.Contains(body, `"name":"octo-harness"`) ||
		!strings.Contains(body, `"tools"`) || !strings.Contains(body, `"version":"9.9"`) {
		t.Errorf("initialize: %d %s", code, body)
	}
	if _, body := post(t, url, tok, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"1999"}}`); !strings.Contains(body, "2025-06-18") {
		t.Errorf("unknown versions fall back to the latest: %s", body)
	}
	if code, body := post(t, url, tok, `{"jsonrpc":"2.0","method":"notifications/initialized"}`); code != http.StatusAccepted || body != "" {
		t.Errorf("notification: %d %q, want 202 with no body", code, body)
	}
	if code, body := post(t, url, tok, `{"jsonrpc":"2.0","id":"s","method":"ping"}`); code != 200 || !strings.Contains(body, `"id":"s"`) || !strings.Contains(body, `"result":{}`) {
		t.Errorf("ping: %d %s", code, body)
	}
	if _, body := post(t, url, tok, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`); !strings.Contains(body, `"name":"echo"`) || !strings.Contains(body, `"inputSchema"`) {
		t.Errorf("tools/list: %s", body)
	}
	if _, body := post(t, url, tok, `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo"}}`); !strings.Contains(body, `"text":"hi"`) || !strings.Contains(body, `"isError":false`) {
		t.Errorf("tools/call: %s", body)
	}
	if len(b.calls) != 1 || b.calls[0] != `p1/echo{}` {
		t.Errorf("backend calls = %v (missing arguments become {})", b.calls)
	}
	if _, body := post(t, url, tok, `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"fails"}}`); !strings.Contains(body, `"isError":true`) {
		t.Errorf("tool error result: %s", body)
	}
	if _, body := post(t, url, tok, `{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"zzz"}}`); !strings.Contains(body, `"code":-32602`) {
		t.Errorf("unknown tool: %s", body)
	}
	if _, body := post(t, url, tok, `{"jsonrpc":"2.0","id":6,"method":"resources/list"}`); !strings.Contains(body, `"code":-32601`) {
		t.Errorf("unknown method: %s", body)
	}
	if code, body := post(t, url, tok, `{not json`); code != http.StatusBadRequest || !strings.Contains(body, `"code":-32700`) {
		t.Errorf("parse error: %d %s", code, body)
	}
}

func TestServerRefusesNonLoopbackPeers(t *testing.T) {
	tokens := mcp.NewTokens()
	tok := tokens.Issue(mcp.Binding{ProjectID: "p"})
	h := mcp.NewServer(tokens, &backend{}, "1")
	for remote, want := range map[string]int{"127.0.0.1:5555": 200, "[::1]:5555": 200, "10.0.0.7:5555": 403, "203.0.113.9:1": 403, "garbage": 403} {
		req := httptest.NewRequest("POST", mcp.Path("p"), strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
		req.RemoteAddr = remote
		req.Header.Set("Authorization", "Bearer "+tok)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != want {
			t.Errorf("peer %s: %d, want %d", remote, rec.Code, want)
		}
	}
}
