package mcprelay_test

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/mcprelay"
)

func TestRelayForwardsEveryMessageKind(t *testing.T) {
	var mu sync.Mutex
	var auth []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		auth = append(auth, r.Header.Get("Authorization"))
		mu.Unlock()
		if !strings.Contains(r.Header.Get("Accept"), "text/event-stream") || !strings.Contains(r.Header.Get("Accept"), "application/json") {
			t.Errorf("Accept = %q", r.Header.Get("Accept"))
		}
		body, _ := io.ReadAll(r.Body)
		switch {
		case bytes.Contains(body, []byte(`"notifications/initialized"`)):
			w.WriteHeader(http.StatusAccepted)
		case bytes.Contains(body, []byte(`"sse"`)):
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"via\":\"sse\"}}\n\n")
		case bytes.Contains(body, []byte(`"denied"`)):
			http.Error(w, "missing or invalid token", http.StatusUnauthorized)
		default:
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, "{\n \"jsonrpc\": \"2.0\",\n \"id\": 1,\n \"result\": {\"ok\": true}\n}\n")
		}
	}))
	defer srv.Close()

	in := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"ping"}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"sse"}`,
		`{"jsonrpc":"2.0","id":3,"method":"denied"}`,
		"",
	}, "\n")
	var out, errOut bytes.Buffer
	if err := mcprelay.Run(context.Background(), srv.URL+"/mcp", "s3cret", "OCTO_MCP_TOKEN", strings.NewReader(in), &out, &errOut); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 3 {
		t.Fatalf("want 3 answers (the notification gets none), got %d: %q", len(lines), out.String())
	}
	got := strings.Join(lines, "\n")
	for _, want := range []string{`"result":{"ok":true}`, `"result":{"via":"sse"}`, `"id":3`, `"error"`, "HTTP 401"} {
		if !strings.Contains(got, want) {
			t.Errorf("output lacks %q:\n%s", want, got)
		}
	}
	for _, l := range lines {
		if strings.Contains(l, "\n") || strings.Contains(l, "  ") {
			t.Errorf("answers must be single compact lines: %q", l)
		}
	}
	for _, a := range auth {
		if a != "Bearer s3cret" {
			t.Errorf("Authorization = %q", a)
		}
	}
	if strings.Contains(out.String(), "s3cret") || strings.Contains(errOut.String(), "s3cret") {
		t.Error("the token must never be written out")
	}
}

func TestRelayReportsUnreachableEndpointAsAnErrorReply(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close()
	var out, errOut bytes.Buffer
	err := mcprelay.Run(context.Background(), url, "t", "X", strings.NewReader(`{"jsonrpc":"2.0","id":7,"method":"ping"}`+"\n"), &out, &errOut)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `"id":7`) || !strings.Contains(out.String(), "unreachable") {
		t.Errorf("out = %q", out.String())
	}
}

func TestRelayValidatesItsArguments(t *testing.T) {
	for name, c := range map[string]struct{ url, token, env string }{
		"bad url":       {"ftp://x", "t", "X"},
		"no url":        {"", "t", "X"},
		"no token env":  {"http://127.0.0.1:1", "t", ""},
		"empty token":   {"http://127.0.0.1:1", "", "X"},
		"url w/o host":  {"http:///x", "t", "X"},
		"relative url?": {"/mcp", "t", "X"},
	} {
		if err := mcprelay.Run(context.Background(), c.url, c.token, c.env, strings.NewReader(""), io.Discard, io.Discard); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
}

func TestRelayConcurrentErrorsDoNotRace(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer srv.Close()
	var lines []string
	for i := range 20 {
		lines = append(lines, `{"jsonrpc":"2.0","id":`+strings.Repeat("1", i%3+1)+`,"method":"ping"}`)
	}
	var out, errOut bytes.Buffer
	if err := mcprelay.Run(context.Background(), srv.URL, "t", "X", strings.NewReader(strings.Join(lines, "\n")+"\n"), &out, &errOut); err != nil {
		t.Fatal(err)
	}
	if errLines := strings.Split(strings.TrimSpace(errOut.String()), "\n"); len(errLines) != 20 {
		t.Fatalf("errOut lines = %d, want 20", len(errLines))
	}
}
