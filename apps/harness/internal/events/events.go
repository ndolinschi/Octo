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
	FileChanged    = "file.changed"
	ProjectUpdated = "project.updated"
	TurnFinished   = "turn.finished"
	AgentCompacted = "agent.compacted"
	// ChangeRecorded carries one recorded file change (v7 changes).
	ChangeRecorded = "change.recorded"
	// ProjectAttention says how many approvals and forms wait for the user.
	ProjectAttention = "project.attention"
	// QueueUpdated carries the whole message queue and whether it is paused.
	QueueUpdated = "queue.updated"
	// SecretsChanged carries the names (never values) of secrets that were stored or deleted.
	SecretsChanged = "secrets.changed"
	// AgentActivity says what an agent is doing now (kind, label, tool id).
	AgentActivity = "agent.activity"
	// ThinkingDelta streams an ACP agent's reasoning; it is never stored.
	ThinkingDelta = "message.thinking_delta"
	// AgentPlan carries an ACP agent's whole current plan.
	AgentPlan = "agent.plan"
	// ToolUpdated carries what an ACP tool_call_update changed on a tool row.
	ToolUpdated = "tool.updated"
	SideDelta   = "side.delta"
	SideDone    = "side.done"
	SideError   = "side.error"
	// SettingsChanged carries the ids of settings a PUT /v1/settings changed
	// (never values). It is delivered on every project stream.
	SettingsChanged = "settings.changed"
)

// Sources of a file.changed event.
const (
	SourceUser  = "user"
	SourceAgent = "agent"
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

// PublishAll delivers an event that belongs to no project (settings.changed) on
// every project stream that exists, each stamped with its own seq. There is no
// global stream: a client watching any project hears it.
func (h *Hub) PublishAll(typ string, fields map[string]any) {
	h.mu.Lock()
	ids := make([]string, 0, len(h.projects))
	for id := range h.projects {
		ids = append(ids, id)
	}
	h.mu.Unlock()
	for _, id := range ids {
		h.Publish(id, typ, fields)
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
