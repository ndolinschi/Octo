package orchestrator

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/ndolinschi/Octo/apps/harness/internal/agent"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// agentSink persists an agent's messages and turns loop activity into events.
type agentSink struct {
	rt      *runtime
	agentID string
	// source labels usage rows; empty means the Messages API.
	source string
	// partial is the text streamed since the last stored message.
	mu      sync.Mutex
	partial strings.Builder
	// The checkpoint of partial in the project's database (see checkpointEvery):
	// when it was last written, the timer of a trailing write, whether a row exists.
	ckAt    time.Time
	ckTimer *time.Timer
	ckRow   bool
	// onCleared, when set, is told how many tool results a request had cleared.
	onCleared func(n int)
}

// Cleared implements agent.ClearObserver.
func (s *agentSink) Cleared(n int) {
	if s.onCleared != nil {
		s.onCleared(n)
	}
}

func (s *agentSink) Message(ctx context.Context, role string, msg anthropic.MessageParam) error {
	_, err := s.store(ctx, role, msg, false)
	return err
}

// store persists and announces a message; stopped flags an assistant message cut short.
func (s *agentSink) store(ctx context.Context, role string, msg anthropic.MessageParam, stopped bool) (projectstore.Message, error) {
	s.mu.Lock()
	s.partial.Reset() // a stored message holds what was streamed so far
	hadRow := s.stopCheckpointLocked()
	s.mu.Unlock()
	if hadRow {
		// After the message, so a crash in between leaves the text twice at worst, never not at all;
		// RecoverInterrupted ignores a checkpoint older than the agent's last message.
		defer s.clearCheckpoint()
	}
	body, err := json.Marshal(agent.ContentOf(msg))
	if err != nil {
		return projectstore.Message{}, err
	}
	body = s.rt.o.secrets.RedactBytes(s.rt.pid(), body) // last guard: no stored secret reaches a transcript row
	c, cancel := dbCtx(ctx)
	defer cancel()
	stored, err := s.rt.db.AppendMessage(c, s.agentID, role, body)
	if err != nil {
		return stored, err
	}
	if stopped {
		if err := s.rt.db.MarkStopped(c, stored.ID); err != nil {
			s.rt.logErr("mark message stopped", err)
		} else {
			stored.Stopped = true
		}
	}
	s.rt.publish(events.MessageCreated, map[string]any{"message": stored})
	return stored, nil
}

// keepPartial stores the text streamed since the last stored message as an
// assistant message flagged stopped: what a cancelled turn had written.
func (s *agentSink) keepPartial(ctx context.Context) {
	s.mu.Lock()
	text := s.partial.String()
	hadRow := s.stopCheckpointLocked()
	s.mu.Unlock()
	if strings.TrimSpace(text) == "" {
		if hadRow {
			s.clearCheckpoint()
		}
		return
	}
	if hadRow {
		defer s.clearCheckpoint()
	}
	text = s.rt.redact(text)
	if _, err := s.store(ctx, "assistant", anthropic.NewAssistantMessage(anthropic.NewTextBlock(text)), true); err != nil {
		s.rt.logErr("store the stopped message", err)
	}
}

func (s *agentSink) TextDelta(text string) {
	s.mu.Lock()
	s.partial.WriteString(text)
	s.checkpointLocked()
	s.mu.Unlock()
	s.rt.publish(events.MessageDelta, map[string]any{"agent_id": s.agentID, "text": text})
}

// checkpointEvery is how often the text an agent is streaming is written to
// the project's database (projectstore/partials.go), so that a crash or a kill
// of the harness keeps what was already on screen. Time, not size, bounds it:
// at most two small writes a second per streaming agent however fast the
// model writes (a write per delta would be dozens a second, each a WAL commit
// with its fsync), and a kill loses at most the last half second of text. A
// delta that comes sooner schedules one trailing write, so text that arrives
// just before a pause (a slow tool call announced, the model thinking) is
// written too.
var checkpointEvery = 500 * time.Millisecond

// checkpointLocked writes the streamed text now when the last write is old
// enough, else makes sure one trailing write is scheduled. s.mu is held.
func (s *agentSink) checkpointLocked() {
	if s.rt == nil || s.rt.db == nil {
		return
	}
	if wait := checkpointEvery - time.Since(s.ckAt); wait > 0 {
		if s.ckTimer == nil {
			s.ckTimer = time.AfterFunc(wait, s.checkpointLater)
		}
		return
	}
	s.writeCheckpointLocked()
}

func (s *agentSink) checkpointLater() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ckTimer == nil {
		return // the message was stored meanwhile
	}
	s.ckTimer = nil
	s.writeCheckpointLocked()
}

// writeCheckpointLocked stores partial, redacted, as the agent's checkpoint. s.mu is held.
func (s *agentSink) writeCheckpointLocked() {
	text := s.partial.String()
	if strings.TrimSpace(text) == "" {
		return
	}
	s.ckAt = time.Now()
	c, cancel := dbCtx(context.Background())
	defer cancel()
	if err := s.rt.db.SavePartial(c, s.agentID, s.rt.redact(text)); err != nil {
		s.rt.logErr("checkpoint streamed text", err)
		return
	}
	s.ckRow = true
}

// stopCheckpointLocked cancels a scheduled checkpoint and reports whether a
// row was written since the last stored message. s.mu is held.
func (s *agentSink) stopCheckpointLocked() bool {
	if s.ckTimer != nil {
		s.ckTimer.Stop()
		s.ckTimer = nil
	}
	s.ckAt = time.Time{}
	had := s.ckRow
	s.ckRow = false
	return had
}

func (s *agentSink) clearCheckpoint() {
	c, cancel := dbCtx(context.Background())
	defer cancel()
	if err := s.rt.db.ClearPartial(c, s.agentID); err != nil {
		s.rt.logErr("clear streamed-text checkpoint", err)
	}
}

// ToolInput implements agent.ToolInputSink: the files a built-in tool call reads or changes.
func (s *agentSink) ToolInput(_, name string, input json.RawMessage) {
	switch name {
	case "read_file", "write_file", "edit":
		var in struct {
			Path string `json:"path"`
		}
		if json.Unmarshal(input, &in) == nil {
			s.rt.touchFile(in.Path)
		}
	case "bash":
		var in struct {
			Command string `json:"command"`
		}
		if json.Unmarshal(input, &in) == nil {
			s.rt.noteCommand(in.Command)
		}
	}
}

// Activity implements agent.ActivitySink.
func (s *agentSink) Activity(kind, label, toolID string) {
	s.rt.activity(s.agentID, kind, label, toolID)
}

func (s *agentSink) ToolStarted(id, name string) {
	s.rt.publish(events.ToolStarted, map[string]any{"agent_id": s.agentID, "tool_use_id": id, "name": name})
}

func (s *agentSink) ToolFinished(id string, isError bool) {
	s.rt.publish(events.ToolFinished, map[string]any{"agent_id": s.agentID, "tool_use_id": id, "is_error": isError})
}

func (s *agentSink) Usage(u agent.Usage) { s.record(u, nil) }

// record stores one usage row (and totals), plus the context window when known.
func (s *agentSink) record(u agent.Usage, w *projectstore.ContextWindow) {
	source := s.source
	if source == "" {
		source = projectstore.SourceAPI
	}
	c, cancel := dbCtx(context.Background())
	defer cancel()
	a, err := s.rt.db.RecordUsage(c, projectstore.UsageRecord{
		AgentID: s.agentID, Model: u.Model, Source: source,
		InputTokens: u.InputTokens, OutputTokens: u.OutputTokens,
		CacheReadTokens: u.CacheReadTokens, CacheWriteTokens: u.CacheWriteTokens,
		CostUSD: u.CostUSD, Context: w,
		ServedModel: u.ServedModel, Tier: u.Tier, RouteTrigger: u.Trigger, RouterRequestID: u.RequestID,
		CostEstimated: u.CostEstimated, FlatRate: u.FlatRate, TokensEstimated: u.TokensEstimated,
	})
	if err != nil {
		s.rt.logErr("record usage", err)
		return
	}
	s.rt.publishAgent(events.AgentUpdated, a)
}

// Compacted stores a router-made summary as the agent's compacted history.
func (s *agentSink) Compacted(ctx context.Context, summary string) error {
	c, cancel := dbCtx(ctx)
	defer cancel()
	comp, err := s.rt.db.AddCompaction(c, s.agentID, summary)
	if err != nil {
		return err
	}
	s.rt.publish(events.AgentCompacted, map[string]any{
		"agent_id": s.agentID, "upto_message_id": comp.UptoMessageID,
		"summary_tokens": comp.SummaryTokens(), "at": comp.CreatedAt, "manual": false,
	})
	s.rt.publish(events.ContextUpdated, map[string]any{"project_id": s.rt.pid()})
	return nil
}

// setContext stores the context window without writing a usage row.
func (s *agentSink) setContext(w projectstore.ContextWindow) {
	c, cancel := dbCtx(context.Background())
	defer cancel()
	a, err := s.rt.db.SetContext(c, s.agentID, w)
	if err != nil {
		s.rt.logErr("set context", err)
		return
	}
	s.rt.publishAgent(events.AgentUpdated, a)
}

func (rt *runtime) logErr(what string, err error) {
	slog.Error(what, "project", rt.pid(), "err", err)
}
