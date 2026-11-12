package orchestrator

import (
	"context"
	"errors"
	"slices"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/ndolinschi/Octo/apps/harness/internal/agent"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// SideMaxRounds is how many rounds of tool calls a side question may use; the
// answer is the model call after the last round.
const SideMaxRounds = 6

// ErrSideInProgress means the project's previous side question is still running.
var ErrSideInProgress = errors.New("orchestrator: a side question is already running")

// SideStart is what Side returns while the answer is still being produced.
type SideStart struct {
	SideID  string
	Message projectstore.SideMessage
}

// side is a running side question; its identity lets a cleared conversation
// discard the answer that was still on its way.
type side struct {
	id     string
	cancel context.CancelFunc
}

// Side starts one side question about the project and returns at once; the
// answer arrives as side.delta / side.done / side.error events. It never takes
// the project's turn slot: it reads a snapshot of the orchestrator's effective
// history (summary plus later messages) and appends nothing to it.
func (o *Orchestrator) Side(ctx context.Context, projectID, text string) (SideStart, error) {
	if o.baseCtx.Err() != nil {
		return SideStart{}, ErrShuttingDown
	}
	db, err := o.store.Get(ctx, projectID)
	if err != nil {
		return SideStart{}, err
	}
	sctx, cancel := context.WithCancel(o.baseCtx)
	run := &side{id: projectstore.NewID("sid"), cancel: cancel}
	if !o.claimSide(projectID, run) {
		cancel()
		return SideStart{}, ErrSideInProgress
	}
	start, history, rt, route, err := o.beginSide(ctx, db, run.id, text)
	if err != nil {
		cancel()
		o.releaseSide(projectID, run)
		return SideStart{}, err
	}
	o.wg.Add(1)
	go func() {
		defer o.wg.Done()
		defer cancel()
		if route.acp {
			rt.runSideACP(sctx, run, route.target, text)
			return
		}
		rt.runSide(sctx, run, history)
	}()
	return start, nil
}

// CancelSide stops the project's running side question, if any.
func (o *Orchestrator) CancelSide(projectID string) {
	o.mu.Lock()
	run := o.sides[projectID]
	delete(o.sides, projectID)
	o.mu.Unlock()
	if run != nil {
		run.cancel()
	}
}

func (o *Orchestrator) claimSide(projectID string, run *side) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	if _, ok := o.sides[projectID]; ok {
		return false
	}
	o.sides[projectID] = run
	return true
}

func (o *Orchestrator) releaseSide(projectID string, run *side) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.sides[projectID] == run {
		delete(o.sides, projectID)
	}
}

// sideRun is what answers a side question: an ACP agent (target) or the
// built-in loop.
type sideRun struct {
	target acpTarget
	acp    bool
}

// beginSide decides what answers the question, snapshots the context a
// built-in answer is made from and stores the question. ErrNoProvider when
// nothing can answer; nothing is stored then.
func (o *Orchestrator) beginSide(ctx context.Context, db *projectstore.DB, sideID, text string) (SideStart, []anthropic.MessageParam, *runtime, sideRun, error) {
	rt, err := o.newRuntime(ctx, db)
	if err != nil {
		return SideStart{}, nil, nil, sideRun{}, err
	}
	target, isACP, err := rt.sideRoute()
	if err != nil {
		return SideStart{}, nil, nil, sideRun{}, err
	}
	route := sideRun{target: target, acp: isACP}
	var history []anthropic.MessageParam
	if !isACP {
		orch, err := db.Orchestrator(ctx)
		if err != nil {
			return SideStart{}, nil, nil, route, err
		}
		if history, err = rt.loadHistory(ctx, orch.ID); err != nil {
			return SideStart{}, nil, nil, route, err
		}
		prior, err := db.SideMessages(ctx)
		if err != nil {
			return SideStart{}, nil, nil, route, err
		}
		history = sideHistory(history, prior, text)
	}
	q, err := db.AppendSide(ctx, sideID, "user", text)
	if err != nil {
		return SideStart{}, nil, nil, route, err
	}
	return SideStart{SideID: sideID, Message: q}, history, rt, route, nil
}

// sideHistory is the request thread of a side question: the orchestrator's
// effective history without an unanswered trailing tool call (its turn may be
// running), the earlier side exchanges, and the new question.
func sideHistory(history []anthropic.MessageParam, prior []projectstore.SideMessage, question string) []anthropic.MessageParam {
	out := slices.Clone(history)
	if n := len(out); n > 0 && out[n-1].OfAssistant != nil && hasToolUse(out[n-1]) {
		out = out[:n-1]
	}
	answered := map[string]bool{}
	for _, m := range prior {
		if m.Role == "assistant" {
			answered[m.SideID] = true
		}
	}
	for _, m := range prior {
		if !answered[m.SideID] {
			continue
		}
		if m.Role == "assistant" {
			out = append(out, anthropic.NewAssistantMessage(anthropic.NewTextBlock(m.Text)))
		} else {
			out = appendUser(out, anthropic.NewTextBlock(sideQuestion(m.Text)))
		}
	}
	return appendUser(out, anthropic.NewTextBlock(sideQuestion(question)))
}

func sideQuestion(text string) string { return "Side question: " + text }

func hasToolUse(m anthropic.MessageParam) bool {
	return slices.ContainsFunc(agent.ContentOf(m), func(b anthropic.ContentBlockParamUnion) bool { return b.OfToolUse != nil })
}

// appendUser adds blocks as a user message, merging into a trailing user
// message so roles keep alternating (tool results stay first in theirs).
func appendUser(msgs []anthropic.MessageParam, blocks ...anthropic.ContentBlockParamUnion) []anthropic.MessageParam {
	if n := len(msgs); n > 0 && msgs[n-1].OfUser != nil {
		merged := append(slices.Clone(msgs[n-1].OfUser.Content), blocks...)
		return append(slices.Clone(msgs[:n-1]), anthropic.NewUserMessage(merged...))
	}
	return append(msgs, anthropic.NewUserMessage(blocks...))
}
