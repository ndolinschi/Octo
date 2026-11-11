package orchestrator

import (
	"context"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// failedRequest recognises a retry. The client's Retry button posts the text of
// the request again; when the orchestrator's last turn failed and its newest
// stored message is that very user message (the turn failed before anything was
// answered), the message is returned to be run again instead of being stored a
// second time, so the transcript never holds the request twice.
//
// A failed turn that stored more after the request (a partial answer, a tool
// call) is not a retry in this sense: its history must end with the new user
// message, so the text is appended as usual.
func (rt *runtime) failedRequest(ctx context.Context, orch projectstore.Agent, text string) (projectstore.Message, bool) {
	failed := orch.Status == projectstore.StatusFailed ||
		(orch.Error != nil && *orch.Error != "" && !strings.HasPrefix(*orch.Error, "warning:"))
	if !failed {
		return projectstore.Message{}, false
	}
	c, cancel := dbCtx(ctx)
	defer cancel()
	last, err := rt.db.LastMessage(c, orch.ID)
	if err != nil || last.Role != "user" {
		return projectstore.Message{}, false
	}
	var parts []string
	for _, b := range last.Content {
		if b.Type != "text" || b.Text == nil {
			return projectstore.Message{}, false // tool results are not a request
		}
		parts = append(parts, *b.Text)
	}
	if strings.TrimSpace(strings.Join(parts, "\n")) != strings.TrimSpace(text) {
		return projectstore.Message{}, false
	}
	return last, true
}

// reuseTurnTask makes a retried request continue the task record its failed
// attempt opened (still open, the request's only message) instead of opening a
// second one. It reports whether there was one.
func (rt *runtime) reuseTurnTask(ctx context.Context, messageID int64) bool {
	c, cancel := dbCtx(ctx)
	defer cancel()
	tasks, err := rt.db.Tasks(c)
	if err != nil {
		return false
	}
	for _, t := range tasks {
		if t.Auto && t.Status == projectstore.TaskOpen && len(t.MessageIDs) == 1 && t.MessageIDs[0] == messageID {
			rt.setTask(t.ID)
			return true
		}
	}
	return false
}

// Project states carried by project.attention beside the counts.
const (
	attentionNone   = "none"
	attentionFailed = "failed"
)

// publishTurnState tells clients how the turn that just started or ended left
// the project: failed (with the error) or none. It is the same event as the
// approval counts, with the counts of now.
func (rt *runtime) publishTurnState(state, errText string) {
	a, in := rt.o.Attention(rt.pid())
	fields := map[string]any{"needs_you": a+in > 0, "approvals": a, "inputs": in, "state": state}
	if errText != "" {
		fields["error"] = errText
	}
	rt.publish(events.ProjectAttention, fields)
}
