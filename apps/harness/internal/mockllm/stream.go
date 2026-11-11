package mockllm

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

func messageID(r *request) string { return fmt.Sprintf("msg_mock_%d", len(r.Messages)) }

func toolID(r *request, i int) string { return fmt.Sprintf("toolu_mock_%d_%d", len(r.Messages), i) }

// usage is the request's synthetic token count: a fixed overhead per message and
// tool plus a quarter byte per character of system prompt and message content,
// so a large tool result is visibly large. Cache fields are filled in by the
// caller from the cache store.
func usage(r *request, rep reply) usageNumbers {
	content := 0
	for _, m := range r.Messages {
		content += len(m.Content)
	}
	return usageNumbers{
		Input:  300 + 120*len(r.Messages) + 40*len(r.Tools) + (len(r.system())+content)/4,
		Output: len(rep.Text)/4 + 45*len(rep.Calls) + 12,
	}
}

func (u usageNumbers) json() map[string]any {
	return map[string]any{
		"input_tokens": u.Input, "output_tokens": u.Output,
		"cache_read_input_tokens": u.CacheRead, "cache_creation_input_tokens": u.CacheWrite,
	}
}

func stopReason(rep reply) string {
	if len(rep.Calls) > 0 {
		return "tool_use"
	}
	return "end_turn"
}

func fullMessage(r *request, rep reply, u usageNumbers) map[string]any {
	content := []any{}
	if rep.Text != "" {
		content = append(content, map[string]any{"type": "text", "text": rep.Text})
	}
	for i, c := range rep.Calls {
		content = append(content, map[string]any{"type": "tool_use", "id": toolID(r, i), "name": c.Name, "input": c.Input})
	}
	return map[string]any{
		"id": messageID(r), "type": "message", "role": "assistant", "model": r.Model,
		"content": content, "stop_reason": stopReason(rep), "stop_sequence": nil,
		"usage": u.json(),
	}
}

type sseWriter struct {
	w     http.ResponseWriter
	f     http.Flusher
	r     *http.Request
	delay time.Duration
}

func (s *sseWriter) event(name string, data map[string]any) bool {
	body, err := json.Marshal(data)
	if err != nil {
		return false
	}
	if _, err := fmt.Fprintf(s.w, "event: %s\ndata: %s\n\n", name, body); err != nil {
		return false
	}
	s.f.Flush()
	return true
}

// pause waits one chunk delay; false means the client went away.
func (s *sseWriter) pause() bool {
	if s.delay <= 0 {
		return s.r.Context().Err() == nil
	}
	select {
	case <-s.r.Context().Done():
		return false
	case <-time.After(s.delay):
		return true
	}
}

func streamReply(w http.ResponseWriter, r *http.Request, req *request, rep reply, u usageNumbers, delay time.Duration) {
	f, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "api_error", "streaming unsupported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	s := &sseWriter{w: w, f: f, r: r, delay: delay}
	start := u.json()
	start["output_tokens"] = 1
	ok = s.event("message_start", map[string]any{"type": "message_start", "message": map[string]any{
		"id": messageID(req), "type": "message", "role": "assistant", "model": req.Model, "content": []any{},
		"stop_reason": nil, "stop_sequence": nil, "usage": start,
	}})
	idx := 0
	if ok && rep.Text != "" {
		ok = s.textBlock(idx, rep.Text)
		idx++
	}
	for i, c := range rep.Calls {
		if !ok {
			return
		}
		ok = s.toolBlock(idx, toolID(req, i), c)
		idx++
	}
	if !ok {
		return
	}
	s.event("message_delta", map[string]any{
		"type": "message_delta", "delta": map[string]any{"stop_reason": stopReason(rep), "stop_sequence": nil},
		"usage": map[string]any{"output_tokens": u.Output},
	})
	s.event("message_stop", map[string]any{"type": "message_stop"})
}

func (s *sseWriter) textBlock(idx int, text string) bool {
	if !s.event("content_block_start", map[string]any{"type": "content_block_start", "index": idx,
		"content_block": map[string]any{"type": "text", "text": ""}}) {
		return false
	}
	for _, chunk := range chunks(strings.SplitAfter(text, " "), 2) {
		if !s.pause() || !s.event("content_block_delta", map[string]any{"type": "content_block_delta", "index": idx,
			"delta": map[string]any{"type": "text_delta", "text": chunk}}) {
			return false
		}
	}
	return s.event("content_block_stop", map[string]any{"type": "content_block_stop", "index": idx})
}

func (s *sseWriter) toolBlock(idx int, id string, c call) bool {
	if !s.event("content_block_start", map[string]any{"type": "content_block_start", "index": idx,
		"content_block": map[string]any{"type": "tool_use", "id": id, "name": c.Name, "input": map[string]any{}}}) {
		return false
	}
	input, err := json.Marshal(c.Input)
	if err != nil {
		return false
	}
	runes := strings.Split(string(input), "")
	for _, part := range chunks(runes, 16) {
		if !s.pause() || !s.event("content_block_delta", map[string]any{"type": "content_block_delta", "index": idx,
			"delta": map[string]any{"type": "input_json_delta", "partial_json": part}}) {
			return false
		}
	}
	return s.event("content_block_stop", map[string]any{"type": "content_block_stop", "index": idx})
}

// chunks joins consecutive pieces n at a time.
func chunks(pieces []string, n int) []string {
	var out []string
	for i := 0; i < len(pieces); i += n {
		out = append(out, strings.Join(pieces[i:min(i+n, len(pieces))], ""))
	}
	return out
}
