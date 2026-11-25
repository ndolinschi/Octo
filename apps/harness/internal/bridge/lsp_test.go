package bridge_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/bridge"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakelsp"
	"github.com/ndolinschi/Octo/apps/harness/internal/lsp"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
)

func fakeLSPRegistry(t *testing.T) *plugins.Registry {
	t.Helper()
	data := t.TempDir()
	writeManifest(t, data, "fake-lsp", map[string]any{
		"name": "fake-lsp", "version": "0.1.0",
		"languageServers": []map[string]any{
			{
				"id": "fake", "label": "Fake LS", "languages": []string{"go"}, "command": os.Args[0],
				"env": map[string]string{fakelsp.EnvChild: "1", "GORACE": "atexit_sleep_ms=0"},
			},
			{"id": "missing", "label": "Missing", "languages": []string{"rust"}, "command": "definitely-not-installed-xyz"},
		},
	})
	return plugins.Load(context.Background(), data, nil, nil)
}

func newLSPEnv(t *testing.T, mopts lsp.Options, bopts ...bridge.Option) *env {
	t.Helper()
	reg := fakeLSPRegistry(t)
	mgr := lsp.NewManager(mopts)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := mgr.Shutdown(ctx); err != nil {
			t.Errorf("lsp shutdown: %v", err)
		}
	})
	return newEnvWith(t, nil, reg, append([]bridge.Option{bridge.WithLSP(reg, mgr)}, bopts...)...)
}

func newLSPProject(t *testing.T, e *env, folders ...string) (pid string) {
	t.Helper()
	fs := []map[string]string{}
	for _, f := range folders {
		fs = append(fs, map[string]string{"path": f})
	}
	var p project.Project
	e.into(t, "POST", "/v1/projects", map[string]any{"name": "L", "folders": fs}, http.StatusCreated, &p)
	return p.ID
}

type lspSession struct {
	ID      string              `json:"session_id"`
	RootURI string              `json:"root_uri"`
	Folders []map[string]string `json:"workspace_folders"`
}

func (e *env) newSession(t *testing.T, pid, server string) lspSession {
	t.Helper()
	var s lspSession
	e.into(t, "POST", "/v1/projects/"+pid+"/lsp/"+server+"/sessions", nil, http.StatusCreated, &s)
	return s
}

func lspPath(pid, sid, tail string) string {
	return "/v1/projects/" + pid + "/lsp/sessions/" + sid + tail
}

type rawEvent struct{ Event, Data string }

type lspStream struct {
	status int
	events <-chan rawEvent
	pings  <-chan struct{}
	cancel context.CancelFunc
}

func (e *env) openStream(t *testing.T, pid, sid string) *lspStream {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, e.url+lspPath(pid, sid, "/events"), nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	st := &lspStream{status: resp.StatusCode, cancel: cancel}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return st
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("content-type = %q", ct)
	}
	events, pings := make(chan rawEvent, 256), make(chan struct{}, 256)
	st.events, st.pings = events, pings
	go func() {
		defer resp.Body.Close()
		defer close(events)
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(make([]byte, 1<<20), 1<<20)
		var cur rawEvent
		for sc.Scan() {
			line := sc.Text()
			switch {
			case line == ": ping":
				pings <- struct{}{}
			case strings.HasPrefix(line, "event: "):
				cur.Event = line[7:]
			case strings.HasPrefix(line, "data: "):
				cur.Data = line[6:]
			case line == "" && cur.Event != "":
				events <- cur
				cur = rawEvent{}
			}
		}
	}()
	return st
}

func (s *lspStream) next(t *testing.T) rawEvent {
	t.Helper()
	select {
	case ev, ok := <-s.events:
		if !ok {
			t.Fatal("stream ended")
		}
		return ev
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for SSE event")
	}
	return rawEvent{}
}

func (s *lspStream) wantEnd(t *testing.T) {
	t.Helper()
	select {
	case ev, ok := <-s.events:
		if ok {
			t.Fatalf("unexpected event %+v", ev)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("stream did not end")
	}
}

func (e *env) postLSP(t *testing.T, pid, sid, body string) (int, []byte) {
	t.Helper()
	resp, err := http.Post(e.url+lspPath(pid, sid, "/messages"), "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var buf bytes.Buffer
	if _, err := buf.ReadFrom(resp.Body); err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, buf.Bytes()
}

func (e *env) sendLSP(t *testing.T, pid, sid, body string) {
	t.Helper()
	if status, raw := e.postLSP(t, pid, sid, body); status != http.StatusAccepted {
		t.Fatalf("post message = %d: %s", status, raw)
	}
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		if cond() {
			return
		}
	}
	t.Fatalf("timed out: %s", what)
}

func TestLSPList(t *testing.T) {
	e := newLSPEnv(t, lsp.Options{})
	pid := newLSPProject(t, e, t.TempDir())
	var resp struct {
		Servers []struct {
			ID, Label string
			Languages []string
			Available bool
		}
	}
	e.into(t, "GET", "/v1/projects/"+pid+"/lsp", nil, http.StatusOK, &resp)
	if len(resp.Servers) != 2 || resp.Servers[0].ID != "fake" || !resp.Servers[0].Available ||
		resp.Servers[0].Label != "Fake LS" || resp.Servers[0].Languages[0] != "go" ||
		resp.Servers[1].ID != "missing" || resp.Servers[1].Available {
		t.Fatalf("servers = %+v", resp.Servers)
	}
	e.wantError(t, "GET", "/v1/projects/nope/lsp", nil, http.StatusNotFound, "not_found")
}

func TestLSPCreateSession(t *testing.T) {
	e := newLSPEnv(t, lsp.Options{})
	first := filepath.Join(t.TempDir(), "sp ace#é%")
	second := t.TempDir()
	for _, d := range []string{first} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	pid := newLSPProject(t, e, first, second)
	s := e.newSession(t, pid, "fake")
	if s.ID == "" || len(s.Folders) != 2 || s.RootURI != s.Folders[0]["uri"] {
		t.Fatalf("session = %+v", s)
	}
	if !strings.HasPrefix(s.RootURI, "file:///") || !strings.Contains(s.RootURI, "sp%20ace%23%C3%A9%25") {
		t.Fatalf("root_uri not percent-encoded: %s", s.RootURI)
	}
	u, err := url.Parse(s.RootURI)
	if err != nil || u.Path != first {
		t.Fatalf("root_uri round trip = %q, %v (want %q)", u.Path, err, first)
	}
	if s.Folders[0]["name"] == "" || s.Folders[1]["uri"] == s.Folders[0]["uri"] {
		t.Fatalf("folders = %+v", s.Folders)
	}

	st := e.openStream(t, pid, s.ID)
	e.sendLSP(t, pid, s.ID, `{"jsonrpc":"2.0","id":1,"method":"fake/cwd"}`)
	var msg struct{ Result string }
	if err := json.Unmarshal([]byte(st.next(t).Data), &msg); err != nil {
		t.Fatal(err)
	}
	want, err := filepath.EvalSymlinks(first)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := filepath.EvalSymlinks(msg.Result); err != nil || got != want {
		t.Fatalf("server cwd = %q (%v), want %q", msg.Result, err, want)
	}
}

func TestLSPCreateSessionErrors(t *testing.T) {
	e := newLSPEnv(t, lsp.Options{})
	withDir := newLSPProject(t, e, t.TempDir())
	noFolders := newLSPProject(t, e)
	tests := []struct {
		name, pid, server string
		status            int
		code              string
	}{
		{"unknown project", "nope", "fake", 404, "not_found"},
		{"unknown server", withDir, "nope", 404, "not_found"},
		{"unavailable server", withDir, "missing", 404, "not_found"},
		{"no folders", noFolders, "fake", 400, "invalid_request"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e.wantError(t, "POST", "/v1/projects/"+tt.pid+"/lsp/"+tt.server+"/sessions", nil, tt.status, tt.code)
		})
	}
}

func TestLSPSessionLimit(t *testing.T) {
	e := newLSPEnv(t, lsp.Options{})
	pid := newLSPProject(t, e, t.TempDir())
	other := newLSPProject(t, e, t.TempDir())
	var first lspSession
	for i := range 8 {
		s := e.newSession(t, pid, "fake")
		if i == 0 {
			first = s
		}
	}
	e.wantError(t, "POST", "/v1/projects/"+pid+"/lsp/fake/sessions", nil, http.StatusTooManyRequests, "too_many_sessions")
	e.newSession(t, other, "fake")
	e.into(t, "DELETE", lspPath(pid, first.ID, ""), nil, http.StatusNoContent, nil)
	e.newSession(t, pid, "fake")
}

func TestLSPPostMessageValidation(t *testing.T) {
	e := newLSPEnv(t, lsp.Options{})
	pid := newLSPProject(t, e, t.TempDir())
	other := newLSPProject(t, e, t.TempDir())
	s := e.newSession(t, pid, "fake")
	tests := []struct {
		name, pid, sid, body string
		status               int
		code                 string
	}{
		{"not json", pid, s.ID, `nope`, 400, "invalid_request"},
		{"array", pid, s.ID, `[]`, 400, "invalid_request"},
		{"empty", pid, s.ID, ``, 400, "invalid_request"},
		{"too large", pid, s.ID, `{"a":"` + strings.Repeat("x", lsp.MaxMessageSize) + `"}`, 413, "message_too_large"},
		{"unknown session", pid, "ls_nope", `{}`, 404, "not_found"},
		{"other project", other, s.ID, `{}`, 404, "not_found"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			status, raw := e.postLSP(t, tt.pid, tt.sid, tt.body)
			var resp struct{ Error struct{ Code string } }
			if err := json.Unmarshal(raw, &resp); err != nil || status != tt.status || resp.Error.Code != tt.code {
				t.Fatalf("got %d %s, want %d %s", status, raw, tt.status, tt.code)
			}
		})
	}
	e.sendLSP(t, pid, s.ID, `{"jsonrpc":"2.0","method":"initialized","params":{}}`)
}

func TestLSPEventsRelayAndExit(t *testing.T) {
	e := newLSPEnv(t, lsp.Options{})
	pid := newLSPProject(t, e, t.TempDir())
	s := e.newSession(t, pid, "fake")
	st := e.openStream(t, pid, s.ID)

	e.sendLSP(t, pid, s.ID, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`)
	ev := st.next(t)
	if ev.Event != "message" || !strings.Contains(ev.Data, `"id":1`) || strings.Contains(ev.Data, "\n") {
		t.Fatalf("initialize reply = %+v", ev)
	}
	e.sendLSP(t, pid, s.ID, `{"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":"file:///a.go"}}}`)
	st.next(t)
	if ev := st.next(t); ev.Event != "message" || !strings.Contains(ev.Data, "publishDiagnostics") {
		t.Fatalf("diagnostics = %+v", ev)
	}

	dup := e.openStream(t, pid, s.ID)
	if dup.status != http.StatusConflict {
		t.Fatalf("second subscriber status = %d, want 409", dup.status)
	}

	e.sendLSP(t, pid, s.ID, `{"jsonrpc":"2.0","method":"fake/exit","params":{"code":5}}`)
	ev = st.next(t)
	if ev.Event != "exit" || ev.Data != `{"code":5}` {
		t.Fatalf("exit event = %+v", ev)
	}
	st.wantEnd(t)
	eventually(t, "ended session unregistered", func() bool {
		status, _ := e.postLSP(t, pid, s.ID, `{}`)
		return status == http.StatusNotFound
	})
}

func TestLSPDeleteKillsServer(t *testing.T) {
	e := newLSPEnv(t, lsp.Options{})
	pid := newLSPProject(t, e, t.TempDir())
	other := newLSPProject(t, e, t.TempDir())
	s := e.newSession(t, pid, "fake")
	st := e.openStream(t, pid, s.ID)

	e.wantError(t, "DELETE", lspPath(other, s.ID, ""), nil, http.StatusNotFound, "not_found")
	e.wantError(t, "DELETE", lspPath(pid, "ls_nope", ""), nil, http.StatusNotFound, "not_found")
	if o := e.openStream(t, other, s.ID); o.status != http.StatusNotFound {
		t.Fatalf("other project events status = %d", o.status)
	}

	e.into(t, "DELETE", lspPath(pid, s.ID, ""), nil, http.StatusNoContent, nil)
	if ev := st.next(t); ev.Event != "exit" || ev.Data != `{"code":-1,"reason":"closed by client"}` {
		t.Fatalf("exit event = %+v", ev)
	}
	st.wantEnd(t)
	e.wantError(t, "DELETE", lspPath(pid, s.ID, ""), nil, http.StatusNotFound, "not_found")
	e.wantError(t, "POST", lspPath(pid, s.ID, "/messages"), map[string]any{}, http.StatusNotFound, "not_found")
}

func TestLSPReapsAfterDisconnectAndNeverConnected(t *testing.T) {
	e := newLSPEnv(t, lsp.Options{IdleTimeout: 300 * time.Millisecond})
	pid := newLSPProject(t, e, t.TempDir())

	never := e.newSession(t, pid, "fake")
	eventually(t, "unsubscribed session reaped", func() bool {
		status, _ := e.postLSP(t, pid, never.ID, `{}`)
		return status == http.StatusNotFound
	})

	s := e.newSession(t, pid, "fake")
	st := e.openStream(t, pid, s.ID)
	time.Sleep(600 * time.Millisecond)
	e.sendLSP(t, pid, s.ID, `{"jsonrpc":"2.0","method":"n"}`)
	st.next(t)
	st.cancel()
	eventually(t, "disconnected session reaped", func() bool {
		status, _ := e.postLSP(t, pid, s.ID, `{}`)
		return status == http.StatusNotFound
	})
}

func TestLSPEventsPing(t *testing.T) {
	e := newLSPEnv(t, lsp.Options{}, bridge.WithPingInterval(20*time.Millisecond))
	pid := newLSPProject(t, e, t.TempDir())
	s := e.newSession(t, pid, "fake")
	st := e.openStream(t, pid, s.ID)
	select {
	case <-st.pings:
	case <-time.After(5 * time.Second):
		t.Fatal("no ping")
	}
}

func TestLSPCORSPreflight(t *testing.T) {
	e := newLSPEnv(t, lsp.Options{})
	for _, method := range []string{"DELETE", "POST", "GET"} {
		req, err := http.NewRequest(http.MethodOptions, e.url+"/v1/projects/p/lsp/sessions/s", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Origin", "http://localhost:1420")
		req.Header.Set("Access-Control-Request-Method", method)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		allow := resp.Header.Get("Access-Control-Allow-Methods")
		if resp.StatusCode != http.StatusNoContent || !strings.Contains(allow, method) {
			t.Fatalf("%s preflight = %d %q", method, resp.StatusCode, allow)
		}
	}
}

func TestLSPWithoutManager(t *testing.T) {
	e := newEnvWith(t, nil, fakeLSPRegistry(t))
	pid := newLSPProject(t, e, t.TempDir())
	var resp struct{ Servers []any }
	e.into(t, "GET", "/v1/projects/"+pid+"/lsp", nil, http.StatusOK, &resp)
	if resp.Servers == nil || len(resp.Servers) != 0 {
		t.Fatalf("servers = %v", resp.Servers)
	}
	e.wantError(t, "POST", "/v1/projects/"+pid+"/lsp/fake/sessions", nil, http.StatusNotFound, "not_found")
}
