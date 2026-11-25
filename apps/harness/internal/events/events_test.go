package events

import (
	"encoding/json"
	"testing"
)

func TestHubSeqAndIsolation(t *testing.T) {
	h := NewHub()
	a, cancelA := h.Subscribe("a")
	defer cancelA()
	b, cancelB := h.Subscribe("b")
	defer cancelB()

	h.Publish("a", AgentCreated, map[string]any{"x": 1})
	h.Publish("a", AgentUpdated, nil)
	h.Publish("b", NoteChanged, nil)

	e1, e2 := <-a, <-a
	if e1.Seq != 1 || e2.Seq != 2 {
		t.Fatalf("seq = %d,%d", e1.Seq, e2.Seq)
	}
	var m map[string]any
	if err := json.Unmarshal(e1.Data, &m); err != nil {
		t.Fatal(err)
	}
	if m["type"] != AgentCreated || m["seq"].(float64) != 1 || m["x"].(float64) != 1 {
		t.Fatalf("payload = %v", m)
	}
	if eb := <-b; eb.Seq != 1 {
		t.Fatalf("project b seq = %d, want 1", eb.Seq)
	}
	select {
	case e := <-a:
		t.Fatalf("project a received foreign event %v", e)
	default:
	}
}

func TestHubDropsLaggingSubscriber(t *testing.T) {
	h := NewHub()
	ch, cancel := h.Subscribe("p")
	defer cancel()
	for range subBuffer + 1 {
		h.Publish("p", MessageDelta, nil)
	}
	n := 0
	for range ch {
		n++
	}
	if n != subBuffer {
		t.Fatalf("drained %d events, want %d before close", n, subBuffer)
	}
}

func TestHubForgetThenCancelIsSafe(t *testing.T) {
	h := NewHub()
	ch, cancel := h.Subscribe("p")
	h.Forget("p")
	if _, ok := <-ch; ok {
		t.Fatal("channel should be closed by Forget")
	}
	cancel()
}

func TestPublishAllReachesEveryProjectStream(t *testing.T) {
	h := NewHub()
	a, cancelA := h.Subscribe("a")
	defer cancelA()
	b, cancelB := h.Subscribe("b")
	defer cancelB()
	h.Publish("a", AgentCreated, nil)
	h.PublishAll(SettingsChanged, map[string]any{"ids": []string{"HARNESS_MODEL_FAST"}})

	<-a // agent.created
	for name, ch := range map[string]<-chan Event{"a": a, "b": b} {
		ev := <-ch
		if ev.Type != SettingsChanged {
			t.Fatalf("%s: type = %s", name, ev.Type)
		}
		var m map[string]any
		if err := json.Unmarshal(ev.Data, &m); err != nil {
			t.Fatal(err)
		}
		if ids, _ := m["ids"].([]any); len(ids) != 1 || ids[0] != "HARNESS_MODEL_FAST" || m["type"] != SettingsChanged {
			t.Fatalf("%s: data = %s", name, ev.Data)
		}
	}
}
