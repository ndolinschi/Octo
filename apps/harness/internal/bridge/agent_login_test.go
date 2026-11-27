package bridge_test

import (
	"bufio"
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
)

type startedLogin struct {
	ID      string `json:"session_id"`
	Command string `json:"command"`
	PID     int    `json:"pid"`
}

func loginPath(agent, lid, tail string) string {
	return "/v1/providers/" + agent + "/login/" + lid + tail
}

// openSSE opens an event stream (token, when set, is sent as ?token=).
func openSSE(t *testing.T, e *env, path, token string) *lspStream {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if token != "" {
		path += "?token=" + url.QueryEscape(token)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, e.url+path, nil)
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
	events, pings := make(chan rawEvent, 256), make(chan struct{}, 256)
	st.events, st.pings = events, pings
	go func() {
		defer resp.Body.Close()
		defer close(events)
		sc := bufio.NewScanner(resp.Body)
		var cur rawEvent
		for sc.Scan() {
			switch line := sc.Text(); {
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

func TestLoginOverHTTP(t *testing.T) {
	e := newAccountsEnv(t)
	var acc accountReply
	e.into(t, "POST", "/v1/providers/cc/accounts", map[string]any{"name": "Work"}, http.StatusCreated, &acc)

	var sl startedLogin
	e.into(t, "POST", "/v1/providers/cc@work/login", map[string]any{"method": "script", "cols": 90, "rows": 24}, http.StatusCreated, &sl)
	if !strings.HasPrefix(sl.ID, "tm_") || sl.PID <= 0 || !strings.HasSuffix(sl.Command, " cc auth login") || !strings.Contains(sl.Command, acc.Account.Dir) {
		t.Fatalf("started = %+v", sl)
	}
	st := openSSE(t, e.env, loginPath("cc@work", sl.ID, "/events"), "")
	if st.status != http.StatusOK {
		t.Fatalf("events = %d", st.status)
	}
	var seen strings.Builder
	for !strings.Contains(seen.String(), "code?") {
		ev := st.next(t)
		if ev.Event == "output" {
			seen.WriteString(decodeOutput(t, ev))
		}
	}
	if code, _ := e.do(t, "POST", loginPath("cc@work", sl.ID, "/resize"), map[string]int{"cols": 100, "rows": 30}); code != http.StatusNoContent {
		t.Fatalf("resize = %d", code)
	}
	if code, _ := e.do(t, "POST", loginPath("cc@work", sl.ID, "/input"), map[string]string{"data": "abc\n"}); code != http.StatusAccepted {
		t.Fatalf("input = %d", code)
	}
	var exit, lastLogin string
	var order []string
	for ev := range st.events {
		order = append(order, ev.Event)
		switch ev.Event {
		case "output":
			seen.WriteString(decodeOutput(t, ev))
		case "exit":
			exit = ev.Data
		case "login":
			var d struct{ State string }
			if err := json.Unmarshal([]byte(ev.Data), &d); err != nil {
				t.Fatal(err)
			}
			lastLogin = d.State
		}
	}
	if !strings.Contains(seen.String(), "thanks-abc") || exit != `{"code":0}` || lastLogin != "ok" {
		t.Fatalf("output %q, exit %q, last login %q, frames %v", seen.String(), exit, lastLogin, order)
	}
	if order[len(order)-1] != "login" {
		t.Fatalf("the final check must follow the exit frame: %v", order)
	}
	// The login is the account's: its folder holds the CLI's marker, the default account's login did not change.
	if _, err := os.Stat(filepath.Join(acc.Account.Dir, "ok")); err != nil {
		t.Fatal(err)
	}
	var list struct {
		Providers []struct{ ID, Login string } `json:"providers"`
	}
	e.into(t, "GET", "/v1/providers", nil, http.StatusOK, &list)
	for _, p := range list.Providers {
		if p.ID == "cc@work" && p.Login != "ok" || p.ID == "cc" && p.Login == "ok" {
			t.Fatalf("provider %s login = %q", p.ID, p.Login)
		}
	}
	e.wantError(t, "POST", loginPath("cc@work", sl.ID, "/input"), map[string]string{"data": "x"}, http.StatusNotFound, "not_found")
}

func TestLoginRoutesAndErrors(t *testing.T) {
	e := newAccountsEnv(t)
	e.into(t, "POST", "/v1/providers/cc/accounts", map[string]any{"name": "Work"}, http.StatusCreated, nil)
	e.wantError(t, "POST", "/v1/providers/nope/login", nil, http.StatusNotFound, "not_found")
	e.wantError(t, "POST", "/v1/providers/plain/login", nil, http.StatusConflict, "login_unavailable")
	e.wantError(t, "POST", "/v1/providers/cc/login", map[string]string{"method": "device"}, http.StatusConflict, "login_unavailable")
	e.wantError(t, "POST", "/v1/providers/cc/login", "{", http.StatusBadRequest, "invalid_request")
	e.wantError(t, "POST", loginPath("cc", "tm_x", "/input"), map[string]string{"data": "x"}, http.StatusNotFound, "not_found")
	e.wantError(t, "POST", loginPath("cc", "tm_x", "/resize"), map[string]int{"cols": 1, "rows": 1}, http.StatusNotFound, "not_found")
	e.wantError(t, "DELETE", loginPath("cc", "tm_x", ""), nil, http.StatusNotFound, "not_found")
	if st := openSSE(t, e.env, loginPath("cc", "tm_x", "/events"), ""); st.status != http.StatusNotFound {
		t.Fatalf("events of an unknown login = %d", st.status)
	}

	// The fallback text comes back even when the login runs.
	var first, second startedLogin
	e.into(t, "POST", "/v1/providers/cc@work/login", map[string]string{"method": "script"}, http.StatusCreated, &first)
	e.into(t, "POST", "/v1/providers/cc@work/login", map[string]string{"method": "script"}, http.StatusCreated, &second)
	// A new start closes the old login of the agent.
	e.wantError(t, "POST", loginPath("cc@work", first.ID, "/input"), map[string]string{"data": "x"}, http.StatusNotFound, "not_found")
	if code, _ := e.do(t, "POST", loginPath("cc@work", second.ID, "/input"), map[string]string{"data": "x"}); code != http.StatusAccepted {
		t.Fatalf("input = %d", code)
	}
	// The login of another agent id is not reachable under this one.
	e.wantError(t, "POST", loginPath("cc", second.ID, "/input"), map[string]string{"data": "x"}, http.StatusNotFound, "not_found")
	if code, _ := e.do(t, "DELETE", loginPath("cc@work", second.ID, ""), nil); code != http.StatusNoContent {
		t.Fatalf("delete = %d", code)
	}
	e.wantError(t, "DELETE", loginPath("cc@work", second.ID, ""), nil, http.StatusNotFound, "not_found")
}

func TestLoginEventsTokenRule(t *testing.T) {
	const token = "s3cret"
	e := newAccountsEnv(t, bridge.WithAPIToken(token), bridge.WithPingInterval(50*time.Millisecond))
	post := func(path string, body string) *http.Response {
		req, err := http.NewRequest("POST", e.url+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}
	resp := post("/v1/providers/cc/login", `{"method":"script"}`)
	var sl startedLogin
	if err := json.NewDecoder(resp.Body).Decode(&sl); err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("start = %d, %v", resp.StatusCode, err)
	}
	resp.Body.Close()

	if st := openSSE(t, e.env, loginPath("cc", sl.ID, "/events"), ""); st.status != http.StatusUnauthorized {
		t.Fatalf("events without a token = %d", st.status)
	}
	if st := openSSE(t, e.env, loginPath("cc", sl.ID, "/events"), "wrong"); st.status != http.StatusUnauthorized {
		t.Fatalf("events with a wrong token = %d", st.status)
	}
	// Only the event stream takes ?token=.
	for _, tail := range []string{"/input", "/resize"} {
		r, err := http.Post(e.url+loginPath("cc", sl.ID, tail)+"?token="+token, "application/json", strings.NewReader(`{"data":"x","cols":80,"rows":24}`))
		if err != nil {
			t.Fatal(err)
		}
		r.Body.Close()
		if r.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%s with ?token= = %d", tail, r.StatusCode)
		}
	}
	st := openSSE(t, e.env, loginPath("cc", sl.ID, "/events"), token)
	if st.status != http.StatusOK {
		t.Fatalf("events with the token = %d", st.status)
	}
	select {
	case <-st.pings:
	case <-time.After(5 * time.Second):
		t.Fatal("no keep-alive on the login stream")
	}
}
