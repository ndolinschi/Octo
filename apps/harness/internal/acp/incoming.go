package acp

import (
	"context"
	"encoding/json"
	"log/slog"
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
	if c.onCommands != nil && json.Unmarshal(params, &n) == nil {
		var head updateHeader
		if json.Unmarshal(n.Update, &head) == nil && head.SessionUpdate == "available_commands_update" {
			var u struct {
				Commands json.RawMessage `json:"availableCommands"`
			}
			if json.Unmarshal(n.Update, &u) == nil {
				c.onCommands(ParseCommands(u.Commands))
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
