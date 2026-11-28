package orchestrator

import (
	"context"
	"strings"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// NEW-8: a request whose turn ended before anything answered it (the harness restarted, the model's service failed,
// the person stopped it) is followed in storage directly by the next request. The person sees how that turn ended
// (its head says interrupted, failed or stopped); the model would see two requests in a row and carry out both.
// So the model's context closes such a request with closedNote, an assistant-side text the harness adds when it
// builds the context (loadHistory, the window, an ACP prompt) and never stores: the transcript, the exchanges and the
// search index stay as they are, and the UI has nothing new to render. The note is added only when another message
// follows the request, so a Retry (which runs the same stored request again, failedRequest) sees the request last
// and runs it once.

// closedNote is the text that closes an unanswered request in the model's context.
func closedNote(e projectstore.TurnEnding) string {
	return "[Octo: the request above was not carried out; " + closedWhy(e) + ". Do not do it or continue it now: " +
		"answer only the message that follows. If the person wants it done, they will ask again.]"
}

// closedPromptNote is closedNote for an ACP prompt: it precedes the new request and quotes the one left unanswered.
func closedPromptNote(prev string, e projectstore.TurnEnding) string {
	return "[Octo: the previous request (\"" + clip(prev, 200) + "\") was not carried out; " + closedWhy(e) +
		". Do not do it or continue it now: answer only the request below. If the person wants it done, they will ask again.]\n\n"
}

func closedWhy(e projectstore.TurnEnding) string {
	switch {
	case e.Interrupted:
		return "it was interrupted before any answer: Octo's local service restarted while it ran"
	case e.Status == projectstore.ExchangeStopped:
		return "the person stopped it before any answer"
	}
	return "it failed before any answer"
}

// partialEndedWhy describes why a turn that already produced partial work did not complete.
func partialEndedWhy(e projectstore.TurnEnding) string {
	if e.Interrupted {
		return "interrupted when Octo's local service restarted"
	}
	return "failed mid-turn"
}

// retryContinuationNote tells the model or ACP agent that a repeated request after a
// partially-completed failed turn is a Retry to continue, not a brand-new request.
func retryContinuationNote(e projectstore.TurnEnding) string {
	why := "failed before finishing"
	if e.Interrupted {
		why = "was interrupted before finishing"
	}
	return "[Octo: the previous attempt at this request " + why + " after making partial progress. " +
		"The user is retrying it — do not start over, re-ask already answered questions, or redo work already completed in this conversation or workspace; " +
		"check what was already done and continue from where the previous attempt stopped.]"
}

// unfinishedTurns is projectstore.UnfinishedTurns; a failure to read counts as none (the context is built as before).
func (rt *runtime) unfinishedTurns(ctx context.Context, agentID string) map[int64]projectstore.TurnEnding {
	m, err := rt.db.UnfinishedTurns(ctx, agentID)
	if err != nil {
		rt.logErr("read unfinished turns", err)
		return nil
	}
	return m
}

// closesUnanswered reports the ending of msgs[i] when it is a request whose turn did not complete and that nothing
// answered: the next stored message is not the assistant's (another request, a sub-agent report note).
func closesUnanswered(msgs []projectstore.Message, i int, ended map[int64]projectstore.TurnEnding) (projectstore.TurnEnding, bool) {
	if len(ended) == 0 || i+1 >= len(msgs) {
		return projectstore.TurnEnding{}, false
	}
	m := msgs[i]
	if m.Role != "user" || messageText(m) == "" || msgs[i+1].Role != "user" {
		return projectstore.TurnEnding{}, false
	}
	e, ok := ended[m.ID]
	return e, ok
}

// closedNoteMessage is closedNote as the assistant message the model reads after the request.
func closedNoteMessage(e projectstore.TurnEnding) anthropic.MessageParam {
	return anthropic.NewAssistantMessage(anthropic.NewTextBlock(closedNote(e)))
}

// unansweredBefore is, for an ACP prompt, the ending of the request before msgs[last] when that request was left
// unanswered (closesUnanswered), with its text; the agent may hold it in its own session, or the recap shows it.
func unansweredBefore(msgs []projectstore.Message, last int, ended map[int64]projectstore.TurnEnding) (string, projectstore.TurnEnding, bool) {
	for j := last - 1; j >= 0; j-- {
		m := msgs[j]
		if m.Role != "user" {
			return "", projectstore.TurnEnding{}, false // something answered or acted after it
		}
		if m.Command == ReportCommand || messageText(m) == "" {
			continue
		}
		if e, ok := closesUnanswered(msgs, j, ended); ok {
			return messageText(m), e, true
		}
		return "", projectstore.TurnEnding{}, false
	}
	return "", projectstore.TurnEnding{}, false
}

// partialFailureBefore reports the ending of the request immediately before msgs[last]
// when that turn failed or was interrupted after producing assistant output.
func partialFailureBefore(msgs []projectstore.Message, last int, ended map[int64]projectstore.TurnEnding) (int, projectstore.TurnEnding, bool) {
	if len(ended) == 0 || last <= 0 || last >= len(msgs) {
		return -1, projectstore.TurnEnding{}, false
	}
	sawAssistant := false
	for j := last - 1; j >= 0; j-- {
		m := msgs[j]
		if m.Role == "assistant" {
			sawAssistant = true
			continue
		}
		if m.Role != "user" || m.Command == ReportCommand || messageText(m) == "" {
			continue
		}
		if !sawAssistant {
			return -1, projectstore.TurnEnding{}, false
		}
		e, ok := ended[m.ID]
		if ok && (e.Status == projectstore.ExchangeFailed || e.Interrupted) {
			return j, e, true
		}
		return -1, projectstore.TurnEnding{}, false
	}
	return -1, projectstore.TurnEnding{}, false
}

// failedRetryBefore reports whether msgs[last] repeats the immediately preceding
// user request whose turn failed or was interrupted after producing partial work.
func failedRetryBefore(msgs []projectstore.Message, last int, ended map[int64]projectstore.TurnEnding) (projectstore.TurnEnding, bool) {
	if last <= 0 || last >= len(msgs) || msgs[last].Command != "" {
		return projectstore.TurnEnding{}, false
	}
	cur := strings.TrimSpace(messageText(msgs[last]))
	if cur == "" {
		return projectstore.TurnEnding{}, false
	}
	prevIdx, e, ok := partialFailureBefore(msgs, last, ended)
	if !ok {
		return projectstore.TurnEnding{}, false
	}
	if strings.TrimSpace(messageText(msgs[prevIdx])) != cur {
		return projectstore.TurnEnding{}, false
	}
	return e, true
}
