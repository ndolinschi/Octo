package bridge_test

import (
	"bufio"
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/bridge"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
)

// An idle project's event stream carries a named `heartbeat` event at every
// ping interval (a comment would be invisible to EventSource), without an id,
// so a client can tell a quiet stream from a half-open one.
func TestEventStreamSendsHeartbeats(t *testing.T) {
	e := newEnvWith(t, nil, nil, bridge.WithPingInterval(30*time.Millisecond))
	var proj project.Project
	e.into(t, "POST", "/v1/projects", map[string]any{
		"name": "Quiet", "folders": []map[string]string{{"path": t.TempDir()}},
	}, http.StatusCreated, &proj)
	stream := e.subscribe(t, proj.ID)
	seen := 0
	timeout := time.After(5 * time.Second)
	for seen < 2 {
		select {
		case ev, ok := <-stream:
			if !ok {
				t.Fatal("stream ended")
			}
			if ev.Type != "heartbeat" {
				continue
			}
			if ev.ID != "" {
				t.Fatalf("heartbeat carries id %q; it must not move the last event id", ev.ID)
			}
			seen++
		case <-timeout:
			t.Fatalf("saw %d heartbeats in 5s at a 30ms interval", seen)
		}
	}
}

// The stream starts by asking EventSource to reconnect after 1 s (its default is 3 s), so a restarted harness is
// picked up quickly.
func TestEventStreamSetsReconnectDelay(t *testing.T) {
	e := newEnv(t, nil)
	var proj project.Project
	e.into(t, "POST", "/v1/projects", map[string]any{
		"name": "Quick", "folders": []map[string]string{{"path": t.TempDir()}},
	}, http.StatusCreated, &proj)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, e.url+"/v1/projects/"+proj.ID+"/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	line, err := bufio.NewReader(resp.Body).ReadString('\n')
	if err != nil || line != "retry: 1000\n" {
		t.Fatalf("first line = %q, %v", line, err)
	}
}
