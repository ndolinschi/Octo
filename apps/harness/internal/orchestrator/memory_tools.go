package orchestrator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/ndolinschi/Octo/apps/harness/internal/agent"
	"github.com/ndolinschi/Octo/apps/harness/internal/memory"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
)

// Names of the orchestrator's memory tools.
const (
	ToolTaskUpdate    = "task_update"
	ToolMemory        = "memory"
	ToolMemorySearch  = "memory_search"
	ToolRecallMessage = "recall_message"
)

// Memory is the project's memory service (one per project, created on first use).
func (o *Orchestrator) Memory(ctx context.Context, pid string) (*memory.Service, error) {
	db, err := o.store.Get(ctx, pid)
	if err != nil {
		return nil, err
	}
	return o.memoryOf(db), nil
}

func (o *Orchestrator) memoryOf(db *projectstore.DB) *memory.Service {
	o.mu.Lock()
	defer o.mu.Unlock()
	if m := o.memories[db.ID()]; m != nil {
		return m
	}
	pid := db.ID()
	redact := func(s string) string { return o.secrets.Redact(pid, s) }
	db.SetRedactor(redact)
	m := &memory.Service{DB: db, Redact: redact, Publish: func(typ string, f map[string]any) { o.hub.Publish(pid, typ, f) }}
	o.memories[pid] = m
	return m
}

func (rt *runtime) memory() *memory.Service { return rt.o.memoryOf(rt.db) }

const taskUpdateSchema = `{"type":"object","properties":{"id":{"type":"string"},"title":{"type":"string"},` +
	`"status":{"type":"string","enum":["open","done","dropped"]},"goal":{"type":"string"},` +
	`"add_constraints":{"type":"array","items":{"type":"string"}},"add_acceptance":{"type":"array","items":{"type":"string"}},` +
	`"add_quotes":{"type":"array","items":{"type":"string"}},"add_decisions":{"type":"array","items":{"type":"string"}},` +
	`"outcome":{"type":"string"},"files":{"type":"array","items":{"type":"string"}}}}`

const memorySchema = `{"type":"object","properties":{"command":{"type":"string","enum":["view","create","str_replace","insert","delete","rename"]},` +
	`"path":{"type":"string"},"file_text":{"type":"string"},"summary":{"type":"string"},"old_str":{"type":"string"},"new_str":{"type":"string"},` +
	`"insert_line":{"type":"integer"},"insert_text":{"type":"string"},"view_range":{"type":"array","items":{"type":"integer"}},` +
	`"old_path":{"type":"string"},"new_path":{"type":"string"}},"required":["command"]}`

const searchSchema = `{"type":"object","properties":{"query":{"type":"string"},` +
	`"in":{"type":"array","items":{"type":"string","enum":["tasks","facts","files","messages"]}},` +
	`"after":{"type":"string"},"before":{"type":"string"},"limit":{"type":"integer"}},"required":["query"]}`

const recallSchema = `{"type":"object","properties":{"id":{"type":"integer"},"exchange_id":{"type":"string"},"session_id":{"type":"string"}}}`

// memoryDefs are the memory tools of the orchestrator.
func (rt *runtime) memoryDefs() []tools.Def {
	text := func(f func(ctx context.Context, in json.RawMessage) (string, error)) tools.Handler {
		return func(ctx context.Context, in json.RawMessage) (string, bool, error) {
			out, err := f(ctx, in)
			if err != nil {
				if errors.Is(err, memory.ErrInvalid) {
					return err.Error(), true, nil
				}
				return "", false, err
			}
			return out, false, nil
		}
	}
	asJSON := func(v any) string { b, _ := json.Marshal(v); return string(b) }
	return []tools.Def{
		{Name: ToolTaskUpdate, InputSchema: json.RawMessage(taskUpdateSchema),
			Description: "Update this request's task record (lists only grow; quotes must be the user's exact words). A side model fills in the rest.",
			Handle: text(func(ctx context.Context, raw json.RawMessage) (string, error) {
				var in memory.UpdateInput
				if err := json.Unmarshal(raw, &in); err != nil {
					return "", fmt.Errorf("%w: %v", memory.ErrInvalid, err)
				}
				t, err := rt.memory().UpdateTask(ctx, in, memory.Turn{TaskID: rt.currentTask(), MessageID: rt.turnID})
				if err != nil {
					return "", err
				}
				rt.setTask(t.ID)
				return asJSON(map[string]any{"id": t.ID, "title": t.Title, "status": t.Status, "facts": len(t.Facts)}), nil
			})},
		{Name: ToolMemory, InputSchema: json.RawMessage(memorySchema),
			Description: "Long-term memory files (markdown): view, create (with a one-line summary), str_replace, insert, delete, rename. view /memories lists them.",
			Handle: text(func(ctx context.Context, raw json.RawMessage) (string, error) {
				var in memory.ToolInput
				if err := json.Unmarshal(raw, &in); err != nil {
					return "", fmt.Errorf("%w: %v", memory.ErrInvalid, err)
				}
				return rt.memory().Command(ctx, in)
			})},
		{Name: ToolMemorySearch, InputSchema: json.RawMessage(searchSchema),
			Description: "Search task records, facts, memory files and all earlier messages (10 hits; dates after/before). Nothing found is reported: say so, do not guess.",
			Handle: text(func(ctx context.Context, raw json.RawMessage) (string, error) {
				var in memory.SearchParams
				if err := json.Unmarshal(raw, &in); err != nil {
					return "", fmt.Errorf("%w: %v", memory.ErrInvalid, err)
				}
				res, err := rt.memory().Search(ctx, in)
				if err != nil {
					return "", err
				}
				return asJSON(res), nil
			})},
		{Name: ToolRecallMessage, InputSchema: json.RawMessage(recallSchema),
			Description: "Return an earlier message word for word (id from a memory_search hit), or an earlier exchange (exchange_id: the request and the answer) or a whole earlier session (session_id: its exchanges, shortened).",
			Handle: text(func(ctx context.Context, raw json.RawMessage) (string, error) {
				var in struct {
					ID         int64  `json:"id"`
					ExchangeID string `json:"exchange_id"`
					SessionID  string `json:"session_id"`
				}
				if err := json.Unmarshal(raw, &in); err != nil {
					return "", fmt.Errorf("%w: %v", memory.ErrInvalid, err)
				}
				switch {
				case in.ExchangeID != "":
					res, err := rt.memory().RecallExchange(ctx, in.ExchangeID)
					if err != nil {
						return "", err
					}
					return asJSON(res), nil
				case in.SessionID != "":
					res, err := rt.memory().RecallSession(ctx, in.SessionID)
					if err != nil {
						return "", err
					}
					return asJSON(res), nil
				case in.ID == 0:
					return "", fmt.Errorf("%w: give id, exchange_id or session_id", memory.ErrInvalid)
				}
				res, err := rt.memory().Recall(ctx, in.ID)
				if err != nil {
					return "", err
				}
				return asJSON(res), nil
			})},
	}
}

// memoryGuidance is the sentence that tells the orchestrator about its memory.
const memoryGuidance = "- Before saying you do not know something from earlier, try memory_search (and recall_message for exact words); keep long-lived knowledge in memory files.\n" + rememberGuidance

// openTurnTask opens the task record for the turn's request. A failure only logs.
func (rt *runtime) openTurnTask(ctx context.Context, text string, messageID int64) {
	t, err := rt.memory().OpenTask(ctx, text, messageID)
	if err != nil {
		rt.logErr("open task record", err)
		return
	}
	rt.setTask(t.ID)
}

// digestTurn asks the side model to digest the finished turn into its task
// record: goal, quotes, decisions, facts (a fact that contradicts an earlier
// one marks it superseded). It runs off the request path and only logs a
// failure; with no side model the record keeps the harness's fallback goal.
func (o *Orchestrator) digestTurn(rt *runtime, orchID, taskID string, messageID int64, reply string, trivial bool) {
	if !o.opts.MemoryDigest || o.builtinOff() != "" || taskID == "" || messageID == 0 || o.baseCtx.Err() != nil {
		return
	}
	o.wg.Add(1)
	go func() {
		defer o.wg.Done()
		ctx, cancel := context.WithTimeout(o.baseCtx, 90*time.Second)
		defer cancel()
		if err := rt.digest(ctx, orchID, taskID, messageID, reply, trivial); err != nil && !errors.Is(err, context.Canceled) {
			slog.Warn("memory digest failed", "project", rt.pid(), "task", taskID, "err", err)
		}
	}()
}

func (rt *runtime) digest(ctx context.Context, orchID, taskID string, messageID int64, reply string, trivial bool) error {
	m := rt.memory()
	task, err := rt.db.Task(ctx, taskID)
	if err != nil {
		return err
	}
	request, _, _, _, err := rt.db.MessageText(ctx, messageID)
	if err != nil {
		return err
	}
	input := m.Redact(memory.DigestInput(task, m.KnownFacts(ctx, taskID, 20), request, reply, m.Candidates(ctx, taskID)...))
	loop := agent.Loop{
		Client: rt.o.opts.Client, Registry: tools.NewRegistry(), Model: rt.models.SideModel(), System: memory.DigestPrompt,
		MaxTurns: 1, Stream: false, SessionID: "digest:" + orchID,
		Sink:            &digestSink{rt: rt, agentID: orchID, role: "digest"},
		NoPromptCaching: rt.o.opts.NoPromptCaching, Limits: rt.o.opts.Limits, Router: rt.o.opts.Router,
		Hints: rt.sideHints(), Gate: rt.loopGate(),
	}
	res, err := loop.Run(ctx, []anthropic.MessageParam{anthropic.NewUserMessage(anthropic.NewTextBlock(input))})
	if err != nil {
		return err
	}
	d, err := memory.ParseDigest(res.Text)
	if err != nil {
		return err
	}
	// A trivial exchange keeps its record only if the digest found something durable in it.
	_, err = m.ApplyDigestOpts(ctx, taskID, messageID, d, memory.DigestOpts{DropIfEmpty: trivial})
	return err
}

// digestSink records the digest call's usage (role "digest": no agent totals).
type digestSink struct {
	rt      *runtime
	agentID string
	// role labels the usage rows ("digest", "completion").
	role string
}

func (s *digestSink) Message(context.Context, string, anthropic.MessageParam) error { return nil }
func (s *digestSink) TextDelta(string)                                              {}
func (s *digestSink) ToolStarted(string, string)                                    {}
func (s *digestSink) ToolFinished(string, bool)                                     {}

func (s *digestSink) Usage(u agent.Usage) {
	c, cancel := dbCtx(context.Background())
	defer cancel()
	if _, err := s.rt.db.RecordUsage(c, projectstore.UsageRecord{
		AgentID: s.agentID, Role: s.role, Model: u.Model, Source: projectstore.SourceAPI,
		InputTokens: u.InputTokens, OutputTokens: u.OutputTokens, CacheReadTokens: u.CacheReadTokens, CacheWriteTokens: u.CacheWriteTokens,
		CostUSD: u.CostUSD, ServedModel: u.ServedModel, Tier: u.Tier, RouteTrigger: u.Trigger, RouterRequestID: u.RequestID,
		CostEstimated: u.CostEstimated,
	}); err != nil {
		s.rt.logErr("record digest usage", err)
	}
}

// TrivialReply is the longest answer (in characters) of a trivial exchange: one
// with no tool call and a short answer.
const TrivialReply = 400

// noteTool counts a tool call of the turn (any agent: a sub-agent exists because
// the orchestrator called a tool).
func (rt *runtime) noteTool() { rt.turnTools.Add(1) }

// touchFile remembers a file a tool call of the turn read or changed, as the
// project shows it (relative to its folder when it lies in one).
func (rt *runtime) touchFile(path string) {
	path = strings.TrimSpace(path)
	if path == "" {
		return
	}
	for _, f := range rt.folders {
		if rel, err := filepath.Rel(f.Path, path); filepath.IsAbs(path) && err == nil && !strings.HasPrefix(rel, "..") {
			path = rel
			break
		}
	}
	rt.touchMu.Lock()
	defer rt.touchMu.Unlock()
	if !slices.Contains(rt.touched, path) && len(rt.touched) < memory.MaxItems {
		rt.touched = append(rt.touched, path)
	}
}

func (rt *runtime) touchedFiles() []string {
	rt.touchMu.Lock()
	defer rt.touchMu.Unlock()
	return slices.Clone(rt.touched)
}

// closeTurnTask settles the turn's task record: files, done with an outcome
// (completed), dropped (cancelled); a trivial exchange's record goes unless the
// digest will decide (then the digest drops it if it finds nothing). It returns
// whether the exchange was trivial and whether the record is gone.
func (o *Orchestrator) closeTurnTask(rt *runtime, status projectstore.AgentStatus, reply string) (trivial, gone bool) {
	id := rt.currentTask()
	if id == "" {
		return false, false
	}
	ctx, cancel := dbCtx(context.Background())
	defer cancel()
	trivial = rt.turnTools.Load() == 0 && utf8.RuneCountInString(strings.TrimSpace(reply)) <= TrivialReply
	digestRuns := o.opts.MemoryDigest && o.builtinOff() == "" && o.baseCtx.Err() == nil
	_, gone, err := rt.memory().CloseTurn(ctx, id, memory.TurnEnd{
		Completed: status == projectstore.StatusCompleted, Cancelled: status == projectstore.StatusCancelled,
		Outcome: reply, Files: rt.touchedFiles(), Trivial: trivial, KeepForDigest: digestRuns,
	})
	if err != nil {
		rt.logErr("close task record", err)
	}
	if gone {
		rt.setTask("")
	}
	return trivial, gone
}
