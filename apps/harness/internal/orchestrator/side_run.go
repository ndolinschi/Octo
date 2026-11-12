package orchestrator

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/ndolinschi/Octo/apps/harness/internal/agent"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/router"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

func (rt *runtime) sideSystemPrompt() string {
	var b strings.Builder
	b.WriteString("You answer a side question about a software project while its orchestrator keeps working. " +
		"The conversation above is the orchestrator's history, shown to you read-only as context: do not continue it, " +
		"do not act on its pending requests, and do not address its user as if you were the orchestrator.\n\n")
	b.WriteString(rt.brief())
	b.WriteString("\nYou must not change anything. You only have read-only tools: list_dir, read_file and search_files " +
		"for the project folders, and read_notes for the project notes. You cannot write files, run commands or delegate. " +
		"Look things up only when the history does not already answer the question.\n" +
		"Answer the latest \"Side question:\" concisely in markdown. Earlier side questions and answers are included for follow-ups. " +
		"If you cannot answer from the history and the read-only tools, say what is missing.\n")
	return b.String()
}

func (rt *runtime) sideHints() router.Hints {
	return router.Hints{
		BudgetKey: rt.pid(), Role: "sub", Depth: 1, TierHint: string(projectstore.TierFast),
		TierPolicy: rt.models.Policy(), Task: "Side question", BudgetUSD: rt.info.BudgetUSD,
	}
}

// runSide runs the one agent loop of a side question and stores and announces
// its answer. A cancelled or failed question leaves no trace but the event.
func (rt *runtime) runSide(ctx context.Context, run *side, history []anthropic.MessageParam) {
	text, err := rt.answerSide(ctx, run, history)
	rt.finishSide(ctx, run, text, err)
}

// finishSide stores and announces a side answer, or its failure.
func (rt *runtime) finishSide(ctx context.Context, run *side, text string, err error) {
	if err != nil {
		rt.failSide(run, err)
		return
	}
	c, cancel := dbCtx(ctx)
	defer cancel()
	rt.o.mu.Lock()
	live := rt.o.sides[rt.pid()] == run
	var m projectstore.SideMessage
	if live {
		m, err = rt.db.AppendSide(c, run.id, "assistant", text)
		delete(rt.o.sides, rt.pid()) // free the slot before announcing: a follow-up may arrive at once
	}
	rt.o.mu.Unlock()
	switch {
	case !live:
		rt.publish(events.SideError, map[string]any{"side_id": run.id, "error": "cancelled"})
	case err != nil:
		rt.failSide(run, err)
	default:
		rt.publish(events.SideDone, map[string]any{"side_id": run.id, "message": m})
	}
}

func (rt *runtime) answerSide(ctx context.Context, run *side, history []anthropic.MessageParam) (string, error) {
	reg, err := rt.sideRegistry()
	if err != nil {
		return "", err
	}
	orch, err := rt.db.Orchestrator(ctx)
	if err != nil {
		return "", err
	}
	loop := agent.Loop{
		Client:    rt.o.opts.Client,
		Registry:  reg,
		Model:     rt.models.SideModel(),
		System:    rt.sideSystemPrompt(),
		MaxTurns:  SideMaxRounds + 1,
		Stream:    rt.o.opts.Stream,
		SessionID: "side:" + orch.ID,
		Sink:      &sideSink{rt: rt, sideID: run.id, agentID: orch.ID},

		NoPromptCaching: rt.o.opts.NoPromptCaching,
		Limits:          rt.o.opts.Limits,
		Router:          rt.o.opts.Router,
		Hints:           rt.sideHints(),
		Gate:            rt.loopGate(),
	}
	res, err := loop.Run(ctx, history)
	if errors.Is(err, agent.ErrMaxTurns) {
		return "", usererr.TooManySteps(fmt.Sprintf("the side question used all %d tool rounds without an answer", SideMaxRounds))
	}
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(res.Text) == "" {
		return "", usererr.ModelCallFailed("the model returned no answer")
	}
	return res.Text, nil
}

func (rt *runtime) failSide(run *side, err error) {
	rt.o.releaseSide(rt.pid(), run)
	if !errors.Is(err, context.Canceled) {
		slog.Error("side question failed", "project", rt.pid(), "err", err)
	}
	c, cancel := dbCtx(context.Background())
	defer cancel()
	if derr := rt.db.DeleteSide(c, run.id); derr != nil {
		rt.logErr("drop failed side question", derr)
	}
	fields := map[string]any{"side_id": run.id}
	if errors.Is(err, context.Canceled) {
		fields["error"] = "cancelled"
		rt.publish(events.SideError, fields)
		return
	}
	u := rt.redactProblem(describe(err))
	fields["error"] = u.Message
	u.AddTo(fields, "hint", "command", "action", "details")
	if errors.Is(err, ErrNoProvider) || IsNoBuiltinLoop(err) {
		fields["code"] = "no_provider"
	}
	rt.publish(events.SideError, fields)
}
