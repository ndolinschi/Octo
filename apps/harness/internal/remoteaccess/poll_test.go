package remoteaccess

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

func TestPollDeliversEventsAndEnds(t *testing.T) {
	r := newRig(t, "", nil)
	r.on()
	tok, id := r.pair(true)

	open := r.do("GET", "/v1/projects/p1/events/poll", tok, nil)
	stream, _ := open.body["stream"].(string)
	if open.status != 200 || stream == "" || len(open.body["events"].([]any)) != 0 {
		t.Fatalf("open: %d %s", open.status, open.raw)
	}
	if open.header.Get("Cache-Control") != "no-store" {
		t.Fatal("poll answer may be cached")
	}
	r.hub.Publish("p1", "message.delta", map[string]any{"text": "hel"})
	r.hub.Publish("p1", "message.delta", map[string]any{"text": "lo"})
	r.hub.Publish("p2", "message.delta", map[string]any{"text": "other project"})
	got := r.do("GET", "/v1/projects/p1/events/poll?stream="+stream+"&wait=5", tok, nil)
	evs := got.body["events"].([]any)
	if got.status != 200 || len(evs) != 2 {
		t.Fatalf("poll: %d %s", got.status, got.raw)
	}
	first := evs[0].(map[string]any)
	if first["type"] != "message.delta" || first["text"] != "hel" || first["seq"] != float64(1) {
		t.Fatalf("event %v", first)
	}

	// Nothing new: answers empty after the wait.
	start := time.Now()
	empty := r.do("GET", "/v1/projects/p1/events/poll?stream="+stream+"&wait=0.3", tok, nil)
	if len(empty.body["events"].([]any)) != 0 || time.Since(start) < 250*time.Millisecond {
		t.Fatalf("empty poll: %s after %v", empty.raw, time.Since(start))
	}

	// Another project's id, or an unknown stream.
	if res := r.do("GET", "/v1/projects/p2/events/poll?stream="+stream, tok, nil); res.status != 410 || res.code() != "stream_gone" {
		t.Fatalf("other project: %d %s", res.status, res.raw)
	}
	if res := r.do("GET", "/v1/projects/p1/events/poll?stream=ps_nope", tok, nil); res.status != 410 {
		t.Fatalf("unknown: %d", res.status)
	}

	// A revoke ends a poll in progress.
	done := make(chan int, 1)
	go func() {
		req, _ := http.NewRequest("GET", r.base()+"/v1/projects/p1/events/poll?stream="+stream+"&wait=20", nil)
		req.Header.Set("Authorization", "Bearer "+tok)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			done <- -1
			return
		}
		var body PollAnswer
		_ = json.NewDecoder(res.Body).Decode(&body)
		_ = res.Body.Close()
		done <- res.StatusCode
	}()
	time.Sleep(200 * time.Millisecond)
	if err := r.m.Revoke(id); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the poll kept waiting after the revoke")
	}
}

func TestPollStreamsPerDeviceAreBounded(t *testing.T) {
	r := newRig(t, "", nil)
	r.on()
	tok, _ := r.pair(true)
	var first string
	for i := 0; i <= MaxStreamsPerDevice; i++ {
		res := r.do("GET", "/v1/projects/p1/events/poll", tok, nil)
		if i == 0 {
			first = res.body["stream"].(string)
		}
		time.Sleep(2 * time.Millisecond)
	}
	if res := r.do("GET", "/v1/projects/p1/events/poll?stream="+first+"&wait=0", tok, nil); res.status != 410 {
		t.Fatalf("the oldest stream survived: %d", res.status)
	}
}
