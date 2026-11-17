package bridge_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/bridge"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/terminal"
)

func newTerminalEnv(t *testing.T, mopts terminal.Options) *env {
	t.Helper()
	mgr := terminal.NewManager(mopts)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := mgr.Shutdown(ctx); err != nil {
			t.Errorf("terminal shutdown: %v", err)
		}
	})
	return newEnvWith(t, nil, nil, bridge.WithTerminals(mgr))
}

type createdTerminal struct {
	ID     string `json:"session_id"`
	Folder string `json:"folder"`
	Cwd    string `json:"cwd"`
	Shell  string `json:"shell"`
	PID    int    `json:"pid"`
}

func openTerminalStream(t *testing.T, e *env, pid, tid string) *lspStream {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, e.url+"/v1/projects/"+pid+"/terminals/"+tid+"/events", nil)
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

func postJSON(t *testing.T, url string, body any) (int, []byte) {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.Post(url, "application/json", bytes.NewReader(raw))
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

func TestTerminalLifecycleAndProcesses(t *testing.T) {
	e := newTerminalEnv(t, terminal.Options{})
	dir := t.TempDir()
	var p project.Project
	e.into(t, "POST", "/v1/projects", map[string]any{
		"name":    "TermProj",
		"folders": []map[string]string{{"label": "app", "path": dir}},
	}, http.StatusCreated, &p)

	var created createdTerminal
	e.into(t, "POST", "/v1/projects/"+p.ID+"/terminals", map[string]any{
		"folder": "app",
		"cols":   100,
		"rows":   30,
	}, http.StatusCreated, &created)
	if !strings.HasPrefix(created.ID, "tm_") {
		t.Fatalf("unexpected session_id: %q", created.ID)
	}
	if created.Folder != "app" || created.PID <= 0 {
		t.Fatalf("unexpected created response: %+v", created)
	}

	st := openTerminalStream(t, e, p.ID, created.ID)
	if st.status != http.StatusOK {
		t.Fatalf("stream status = %d", st.status)
	}

	// Verify active terminal session appears in GET /v1/projects/{pid}/processes.
	var procs struct {
		Processes []struct {
			ID     string `json:"id"`
			Kind   string `json:"kind"`
			Status string `json:"status"`
		} `json:"processes"`
	}
	e.into(t, "GET", "/v1/projects/"+p.ID+"/processes", nil, http.StatusOK, &procs)
	foundProc := false
	for _, pr := range procs.Processes {
		if pr.ID == "term:"+created.ID && pr.Kind == "terminal" {
			foundProc = true
			break
		}
	}
	if !foundProc {
		t.Fatalf("expected term:%s in processes, got %+v", created.ID, procs.Processes)
	}

	// Resize terminal.
	status, raw := postJSON(t, e.url+"/v1/projects/"+p.ID+"/terminals/"+created.ID+"/resize", map[string]any{
		"cols": 120,
		"rows": 40,
	})
	if status != http.StatusNoContent {
		t.Fatalf("resize = %d: %s", status, raw)
	}

	// Send input and read base64 output + exit event.
	status, raw = postJSON(t, e.url+"/v1/projects/"+p.ID+"/terminals/"+created.ID+"/input", map[string]any{
		"data": "echo bridge_term_ok\nexit 0\n",
	})
	if status != http.StatusAccepted {
		t.Fatalf("input = %d: %s", status, raw)
	}

	var out strings.Builder
	sawExit := false
	deadline := time.After(10 * time.Second)
	for !sawExit {
		select {
		case ev, ok := <-st.events:
			if !ok {
				t.Fatalf("stream closed before exit event; output so far: %q", out.String())
			}
			switch ev.Event {
			case "output":
				var payload struct {
					Data string `json:"data"`
				}
				if err := json.Unmarshal([]byte(ev.Data), &payload); err != nil {
					t.Fatalf("decode output payload: %v", err)
				}
				decoded, err := base64.StdEncoding.DecodeString(payload.Data)
				if err != nil {
					t.Fatalf("decode base64: %v", err)
				}
				out.Write(decoded)
			case "exit":
				var payload struct {
					Code int `json:"code"`
				}
				if err := json.Unmarshal([]byte(ev.Data), &payload); err != nil {
					t.Fatalf("decode exit payload: %v", err)
				}
				if payload.Code != 0 {
					t.Fatalf("exit code = %d, want 0", payload.Code)
				}
				sawExit = true
			}
		case <-deadline:
			t.Fatalf("timed out waiting for terminal output/exit; got %q", out.String())
		}
	}
	if !strings.Contains(out.String(), "bridge_term_ok") {
		t.Fatalf("expected bridge_term_ok in terminal output, got %q", out.String())
	}
}

func TestTerminalDeleteAndUnknownFolder(t *testing.T) {
	e := newTerminalEnv(t, terminal.Options{})
	dir := t.TempDir()
	var p project.Project
	e.into(t, "POST", "/v1/projects", map[string]any{
		"name":    "TermDel",
		"folders": []map[string]string{{"label": "root", "path": dir}},
	}, http.StatusCreated, &p)

	status, _ := postJSON(t, e.url+"/v1/projects/"+p.ID+"/terminals", map[string]any{"folder": "missing"})
	if status != http.StatusBadRequest {
		t.Fatalf("unknown folder status = %d, want 400", status)
	}

	var created createdTerminal
	e.into(t, "POST", "/v1/projects/"+p.ID+"/terminals", map[string]any{}, http.StatusCreated, &created)

	req, err := http.NewRequest(http.MethodDelete, e.url+"/v1/projects/"+p.ID+"/terminals/"+created.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete status = %d, want 204", resp.StatusCode)
	}
}

func TestTerminalStreamAPITokenQuery(t *testing.T) {
	const tok = "secret-test-token-123456"
	mgr := terminal.NewManager(terminal.Options{})
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = mgr.Shutdown(ctx)
	})
	e := newEnvWith(t, nil, nil, bridge.WithTerminals(mgr), bridge.WithAPIToken(tok))
	dir := t.TempDir()

	authPost := func(path string, body any) *http.Response {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		req, err := http.NewRequest(http.MethodPost, e.url+path, bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+tok)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}

	resp := authPost("/v1/projects", map[string]any{
		"name":    "AuthTerm",
		"folders": []map[string]string{{"label": "root", "path": dir}},
	})
	var p project.Project
	if err := json.NewDecoder(resp.Body).Decode(&p); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()

	resp = authPost("/v1/projects/"+p.ID+"/terminals", map[string]any{})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create status = %d, want 201", resp.StatusCode)
	}
	var created createdTerminal
	if err := json.NewDecoder(resp.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()

	// Without token -> 401.
	noTokResp, err := http.Get(e.url + "/v1/projects/" + p.ID + "/terminals/" + created.ID + "/events")
	if err != nil {
		t.Fatal(err)
	}
	noTokResp.Body.Close()
	if noTokResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("without token status = %d, want 401", noTokResp.StatusCode)
	}

	// With ?token= query param -> 200 text/event-stream.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, e.url+"/v1/projects/"+p.ID+"/terminals/"+created.ID+"/events?token="+tok, nil)
	if err != nil {
		t.Fatal(err)
	}
	tokResp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer tokResp.Body.Close()
	if tokResp.StatusCode != http.StatusOK {
		t.Fatalf("with ?token= status = %d, want 200", tokResp.StatusCode)
	}
}
