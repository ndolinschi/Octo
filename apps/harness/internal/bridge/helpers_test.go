package bridge_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/anthropicclient"
	"github.com/ndolinschi/Octo/apps/harness/internal/bridge"
	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

type env struct {
	url  string
	gate chan struct{}
}

// newEnv wires the full stack against the scripted mock Messages server. While
// gate is open (non-nil and not closed) every LLM request blocks.
func newEnv(t *testing.T, gate chan struct{}) *env {
	t.Helper()
	llm := mockllm.New(0)
	llmSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if gate != nil {
			select {
			case <-gate:
			case <-r.Context().Done():
				return
			}
		}
		llm.ServeHTTP(w, r)
	}))
	t.Cleanup(llmSrv.Close)

	store, err := projectstore.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	hub := events.NewHub()
	notes := project.NewNotes(store, hub)
	orch := orchestrator.New(store, hub, notes, orchestrator.Options{
		Client: anthropicclient.New("k", llmSrv.URL, ""), MaxTurns: 12, Stream: true,
	})
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = orch.Shutdown(ctx)
	})
	svc := project.NewService(store, hub, orch, project.Defaults{Models: config.DefaultModels(), MaxDepth: config.DefaultMaxDepth})
	srv := httptest.NewServer(bridge.New(svc, notes))
	t.Cleanup(srv.Close)
	return &env{url: srv.URL, gate: gate}
}

func (e *env) do(t *testing.T, method, path string, body any) (int, []byte) {
	t.Helper()
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, e.url+path, rdr)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	out, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, out
}

func (e *env) into(t *testing.T, method, path string, body any, wantStatus int, v any) {
	t.Helper()
	status, raw := e.do(t, method, path, body)
	if status != wantStatus {
		t.Fatalf("%s %s = %d, want %d: %s", method, path, status, wantStatus, raw)
	}
	if v != nil {
		if err := json.Unmarshal(raw, v); err != nil {
			t.Fatalf("decode %s: %v", raw, err)
		}
	}
}

func (e *env) wantError(t *testing.T, method, path string, body any, wantStatus int, wantCode string) {
	t.Helper()
	var resp struct {
		Error struct{ Code, Message string } `json:"error"`
	}
	e.into(t, method, path, body, wantStatus, &resp)
	if resp.Error.Code != wantCode || resp.Error.Message == "" {
		t.Fatalf("%s %s error = %+v, want code %q", method, path, resp.Error, wantCode)
	}
}

type sseEvent struct {
	ID, Type string
	Data     map[string]any
}

// subscribe opens the SSE stream and returns a channel of parsed events.
func (e *env) subscribe(t *testing.T, pid string) <-chan sseEvent {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, e.url+"/v1/projects/"+pid+"/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("content-type = %q", ct)
	}
	out := make(chan sseEvent, 4096)
	go func() {
		defer resp.Body.Close()
		defer close(out)
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(make([]byte, 1<<20), 1<<20)
		var cur sseEvent
		for sc.Scan() {
			line := sc.Text()
			switch {
			case strings.HasPrefix(line, "id: "):
				cur.ID = line[4:]
			case strings.HasPrefix(line, "event: "):
				cur.Type = line[7:]
			case strings.HasPrefix(line, "data: "):
				if err := json.Unmarshal([]byte(line[6:]), &cur.Data); err != nil {
					return
				}
			case line == "":
				if cur.Type != "" {
					out <- cur
				}
				cur = sseEvent{}
			}
		}
	}()
	return out
}

// collectUntilTurnFinished gathers events up to and including turn.finished.
func collectUntilTurnFinished(t *testing.T, ch <-chan sseEvent) []sseEvent {
	t.Helper()
	var got []sseEvent
	timeout := time.After(30 * time.Second)
	for {
		select {
		case ev, ok := <-ch:
			if !ok {
				t.Fatalf("stream ended early after %d events", len(got))
			}
			got = append(got, ev)
			if ev.Type == events.TurnFinished {
				return got
			}
		case <-timeout:
			t.Fatalf("timed out after %d events", len(got))
		}
	}
}

func count(evs []sseEvent, typ string) int {
	n := 0
	for _, e := range evs {
		if e.Type == typ {
			n++
		}
	}
	return n
}
