package events

import (
	"encoding/json"
	"log/slog"
	"sync"
)

const (
	AgentCreated   = "agent.created"
	AgentUpdated   = "agent.updated"
	MessageCreated = "message.created"
	MessageDelta   = "message.delta"
	ToolStarted    = "tool.started"
	ToolFinished   = "tool.finished"
	NoteChanged    = "note.changed"
	ProjectUpdated = "project.updated"
	TurnFinished   = "turn.finished"
)

const subBuffer = 2048

// Event is one serialized BridgeEvent: Data already contains type and seq.
type Event struct {
	Seq  int64
	Type string
	Data []byte
}

// Hub fans events out to per-project subscribers, stamping a per-project seq.
type Hub struct {
	mu       sync.Mutex
	projects map[string]*stream
}

type stream struct {
	seq  int64
	subs map[chan Event]struct{}
}

func NewHub() *Hub {
	return &Hub{projects: make(map[string]*stream)}
}

// Publish stamps and delivers an event. fields are merged beside type and seq.
// A subscriber that falls too far behind is closed so its client refetches.
func (h *Hub) Publish(projectID, typ string, fields map[string]any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.stream(projectID)
	s.seq++
	payload := make(map[string]any, len(fields)+2)
	for k, v := range fields {
		payload[k] = v
	}
	payload["type"] = typ
	payload["seq"] = s.seq
	data, err := json.Marshal(payload)
	if err != nil {
		slog.Error("event marshal", "type", typ, "err", err)
		return
	}
	ev := Event{Seq: s.seq, Type: typ, Data: data}
	for ch := range s.subs {
		select {
		case ch <- ev:
		default:
			delete(s.subs, ch)
			close(ch)
		}
	}
}

// Subscribe returns a channel of future events and a cancel func. The channel
// is closed when the subscriber is dropped for lagging or cancelled.
func (h *Hub) Subscribe(projectID string) (<-chan Event, func()) {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.stream(projectID)
	ch := make(chan Event, subBuffer)
	s.subs[ch] = struct{}{}
	cancel := func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if _, ok := s.subs[ch]; ok {
			delete(s.subs, ch)
			close(ch)
		}
	}
	return ch, cancel
}

// Forget drops a deleted project's stream, closing its subscribers.
func (h *Hub) Forget(projectID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if s, ok := h.projects[projectID]; ok {
		for ch := range s.subs {
			delete(s.subs, ch)
			close(ch)
		}
		delete(h.projects, projectID)
	}
}

func (h *Hub) stream(id string) *stream {
	s, ok := h.projects[id]
	if !ok {
		s = &stream{subs: make(map[chan Event]struct{})}
		h.projects[id] = s
	}
	return s
}
