package acp

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
)

func (c *Client) current() *run {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.active
}

func (c *Client) notify(_ context.Context, method string, params json.RawMessage) {
	if method != methodUpdate {
		slog.Debug("acp: ignoring notification", "agent", c.name, "method", method)
		return
	}
	var n sessionNotification
	if (c.onCommands != nil || c.onMode != nil) && json.Unmarshal(params, &n) == nil {
		var head updateHeader
		if json.Unmarshal(n.Update, &head) == nil {
			switch head.SessionUpdate {
			case "available_commands_update":
				if c.onCommands != nil {
					var u struct {
						Commands json.RawMessage `json:"availableCommands"`
					}
					if json.Unmarshal(n.Update, &u) == nil {
						c.onCommands(ParseCommands(u.Commands))
					}
				}
			case "current_mode_update":
				if c.onMode != nil {
					var u struct {
						CurrentModeID string `json:"currentModeId"`
						ModeID        string `json:"modeId"`
					}
					if json.Unmarshal(n.Update, &u) == nil {
						id := u.CurrentModeID
						if id == "" {
							id = u.ModeID
						}
						if id != "" {
							c.onMode(n.SessionID, id)
						}
					}
				}
			}
		}
	}
	r := c.current()
	if r == nil {
		return
	}
	if err := json.Unmarshal(params, &n); err != nil || n.SessionID != r.sessionID {
		slog.Debug("acp: dropping session/update", "agent", c.name, "err", err)
		return
	}
	var head updateHeader
	if err := json.Unmarshal(n.Update, &head); err != nil {
		slog.Debug("acp: update without discriminator", "agent", c.name, "err", err)
		return
	}
	c.applyUpdate(r, head.SessionUpdate, n.Update)
}

func (c *Client) applyUpdate(r *run, kind string, raw json.RawMessage) {
	if o, ok := r.h.(UpdateObserver); ok {
		o.UpdateSeen(r.ctx, kind)
	}
	switch kind {
	case "agent_thought_chunk":
		var chunk contentChunk
		if h, ok := r.h.(ThoughtHandler); ok {
			if err := json.Unmarshal(raw, &chunk); err == nil && chunk.Content.Type == "text" && chunk.Content.Text != "" {
				h.AgentThought(r.ctx, chunk.Content.Text)
			}
		}
	case "plan":
		if h, ok := r.h.(PlanHandler); ok {
			var p struct {
				Entries []PlanEntry `json:"entries"`
			}
			if err := json.Unmarshal(raw, &p); err == nil {
				h.Plan(r.ctx, p.Entries)
			}
		}
	case "agent_message_chunk":
		var chunk contentChunk
		if err := json.Unmarshal(raw, &chunk); err == nil && chunk.Content.Type == "text" && chunk.Content.Text != "" {
			r.h.AgentText(r.ctx, chunk.Content.Text)
		}
	case "tool_call":
		var tc ToolCall
		if err := json.Unmarshal(raw, &tc); err == nil && tc.ID != "" {
			r.h.ToolCall(r.ctx, tc)
		}
	case "tool_call_update":
		var tu ToolCallUpdate
		if err := json.Unmarshal(raw, &tu); err == nil && tu.ID != "" {
			r.h.ToolCallUpdate(r.ctx, tu)
		}
	case "usage_update":
		var u Usage
		if err := json.Unmarshal(raw, &u); err == nil {
			r.h.Usage(r.ctx, u)
		}
	case "compaction_update":
		if h, ok := r.h.(CompactionHandler); ok {
			if ev, ok := parseCompactionUpdate(raw); ok {
				h.Compaction(r.ctx, ev)
			}
		}
	case "compaction_summary_chunk":
		if h, ok := r.h.(CompactionHandler); ok {
			var cc struct {
				CompactionID string       `json:"compactionId"`
				Content      contentBlock `json:"content"`
			}
			if err := json.Unmarshal(raw, &cc); err == nil && cc.Content.Type == "text" && cc.Content.Text != "" {
				h.Compaction(r.ctx, CompactionEvent{
					ID:      cc.CompactionID,
					Status:  CompactionInProgress,
					Summary: cc.Content.Text,
				})
			}
		}
	case "session_info_update":
		if h, ok := r.h.(CompactionHandler); ok {
			if ev, ok := parseSessionInfoCompaction(raw); ok {
				h.Compaction(r.ctx, ev)
			}
		}
	case "agent_error":
		if h, ok := r.h.(ErrorHandler); ok {
			if ae, ok := parseAgentError(raw); ok {
				h.AgentError(r.ctx, ae)
			}
		}
	default:
		slog.Debug("acp: ignoring session update", "agent", c.name, "variant", kind)
	}
}

func (c *Client) request(_ context.Context, method string, params json.RawMessage) (any, *RPCError) {
	r := c.current()
	if r == nil && (method == methodPermission || method == methodReadFile || method == methodWriteFile) {
		return nil, &RPCError{Code: codeServerError, Message: "no active session"}
	}
	switch method {
	case methodPermission:
		var req PermissionRequest
		if err := json.Unmarshal(params, &req); err != nil {
			return nil, invalidParams(err)
		}
		if c.cancelling.Load() {
			return permissionResult{Outcome: permissionOutcome{Outcome: "cancelled"}}, nil
		}
		pctx := r.permCtx
		if pctx == nil {
			pctx = r.ctx
		}
		id := r.h.RequestPermission(pctx, req)
		if pctx.Err() != nil {
			// The prompt was cancelled while the question was open: whatever the
			// handler settled on, the answer is "cancelled" (ACP's rule for a
			// permission request outstanding at session/cancel).
			return permissionResult{Outcome: permissionOutcome{Outcome: "cancelled"}}, nil
		}
		if id != "" {
			return permissionResult{Outcome: permissionOutcome{Outcome: "selected", OptionID: id}}, nil
		}
		return permissionResult{Outcome: permissionOutcome{Outcome: "cancelled"}}, nil
	case methodReadFile:
		var req ReadTextFileParams
		if err := json.Unmarshal(params, &req); err != nil {
			return nil, invalidParams(err)
		}
		content, err := r.h.ReadTextFile(r.ctx, req)
		if err != nil {
			return nil, &RPCError{Code: codeServerError, Message: err.Error()}
		}
		return map[string]string{"content": content}, nil
	case methodWriteFile:
		var req WriteTextFileParams
		if err := json.Unmarshal(params, &req); err != nil {
			return nil, invalidParams(err)
		}
		if err := r.h.WriteTextFile(r.ctx, req); err != nil {
			return nil, &RPCError{Code: codeServerError, Message: err.Error()}
		}
		return struct{}{}, nil
	default:
		return nil, &RPCError{Code: codeMethodMissing, Message: "method not found: " + method}
	}
}

func invalidParams(err error) *RPCError {
	return &RPCError{Code: codeInvalidParams, Message: "invalid params: " + err.Error()}
}

func normalizeCompactionStatus(s string) CompactionStatus {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "started", "in_progress", "running":
		return CompactionInProgress
	case "completed", "done":
		return CompactionCompleted
	case "failed", "error":
		return CompactionFailed
	case "cancelled", "canceled":
		return CompactionCancelled
	default:
		return CompactionStatus(strings.TrimSpace(s))
	}
}

func flattenTextBlocks(blocks []contentBlock) string {
	var b strings.Builder
	for _, blk := range blocks {
		if blk.Type == "text" && blk.Text != "" {
			b.WriteString(blk.Text)
		}
	}
	return b.String()
}

func parseCompactionUpdate(raw json.RawMessage) (CompactionEvent, bool) {
	var cu struct {
		CompactionID string          `json:"compactionId"`
		Status       string          `json:"status"`
		Summary      []contentBlock  `json:"summary"`
		Content      []contentBlock  `json:"content"`
		Error        json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal(raw, &cu); err != nil {
		return CompactionEvent{}, false
	}
	st := normalizeCompactionStatus(cu.Status)
	if st == "" && len(cu.Summary) == 0 && len(cu.Content) == 0 {
		return CompactionEvent{}, false
	}
	summary := flattenTextBlocks(cu.Summary)
	if summary == "" {
		summary = flattenTextBlocks(cu.Content)
	}
	var errText string
	if ae, ok := parseAgentErrorPayload(cu.Error); ok {
		errText = ae.Message
	}
	return CompactionEvent{ID: cu.CompactionID, Status: st, Summary: summary, Error: errText}, true
}

func parseSessionInfoCompaction(raw json.RawMessage) (CompactionEvent, bool) {
	var si struct {
		Meta map[string]json.RawMessage `json:"_meta"`
	}
	if err := json.Unmarshal(raw, &si); err != nil || len(si.Meta) == 0 {
		return CompactionEvent{}, false
	}
	ocRaw, ok := si.Meta["opencode/compaction"]
	if !ok {
		return CompactionEvent{}, false
	}
	var oc struct {
		Status string          `json:"status"`
		Error  json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal(ocRaw, &oc); err != nil || strings.TrimSpace(oc.Status) == "" {
		return CompactionEvent{}, false
	}
	var errText string
	if ae, ok := parseAgentErrorPayload(oc.Error); ok {
		errText = ae.Message
	}
	return CompactionEvent{
		Status: normalizeCompactionStatus(oc.Status),
		Error:  errText,
	}, true
}

func parseAgentError(raw json.RawMessage) (AgentError, bool) {
	var envelope struct {
		Error      json.RawMessage `json:"error"`
		Name       string          `json:"name"`
		Code       string          `json:"code"`
		Message    string          `json:"message"`
		StatusCode int             `json:"statusCode"`
		Data       *struct {
			Message    string `json:"message"`
			StatusCode int    `json:"statusCode"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return AgentError{}, false
	}
	if len(envelope.Error) > 0 {
		if ae, ok := parseAgentErrorPayload(envelope.Error); ok {
			return ae, true
		}
	}
	ae := AgentError{
		Name:       strings.TrimSpace(envelope.Name),
		Code:       strings.TrimSpace(envelope.Code),
		Message:    strings.TrimSpace(envelope.Message),
		StatusCode: envelope.StatusCode,
	}
	if envelope.Data != nil {
		if ae.Message == "" {
			ae.Message = strings.TrimSpace(envelope.Data.Message)
		}
		if ae.StatusCode == 0 {
			ae.StatusCode = envelope.Data.StatusCode
		}
	}
	return ae, ae.Message != "" || ae.Name != "" || ae.Code != ""
}

func parseAgentErrorPayload(raw json.RawMessage) (AgentError, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return AgentError{}, false
	}
	var str string
	if json.Unmarshal(raw, &str) == nil && strings.TrimSpace(str) != "" {
		return AgentError{Message: strings.TrimSpace(str)}, true
	}
	var obj struct {
		Name       string `json:"name"`
		Code       string `json:"code"`
		Message    string `json:"message"`
		StatusCode int    `json:"statusCode"`
		Data       *struct {
			Message    string `json:"message"`
			StatusCode int    `json:"statusCode"`
			ProviderID string `json:"providerID"`
		} `json:"data"`
	}
	if json.Unmarshal(raw, &obj) != nil {
		return AgentError{}, false
	}
	ae := AgentError{
		Name:       strings.TrimSpace(obj.Name),
		Code:       strings.TrimSpace(obj.Code),
		Message:    strings.TrimSpace(obj.Message),
		StatusCode: obj.StatusCode,
	}
	if obj.Data != nil {
		if ae.Message == "" {
			ae.Message = strings.TrimSpace(obj.Data.Message)
		}
		if ae.StatusCode == 0 {
			ae.StatusCode = obj.Data.StatusCode
		}
	}
	if ae.Message == "" && ae.Name != "" {
		ae.Message = ae.Name
	}
	return ae, ae.Message != "" || ae.Name != "" || ae.Code != ""
}
