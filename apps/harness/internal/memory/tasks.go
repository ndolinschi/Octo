package memory

import (
	"context"
	"errors"
	"slices"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// Turn is where an update comes from: the task the harness opened for the
// request and the request's message.
type Turn struct {
	TaskID    string
	MessageID int64
}

// UpdateInput is the task_update tool's input. Lists only add.
type UpdateInput struct {
	ID             string   `json:"id"`
	Title          *string  `json:"title"`
	Status         *string  `json:"status"`
	Goal           *string  `json:"goal"`
	AddConstraints []string `json:"add_constraints"`
	AddAcceptance  []string `json:"add_acceptance"`
	AddQuotes      []string `json:"add_quotes"`
	AddDecisions   []string `json:"add_decisions"`
	Outcome        *string  `json:"outcome"`
	Files          []string `json:"files"`
}

// UpdateTask applies what the orchestrator says about a task. Without an id it
// is the record of this turn; with another open task's id the turn's message is
// attached to that task (and the record the harness opened for it, if nobody
// edited it, is dropped). Quotes must be wording of the user's request.
func (s *Service) UpdateTask(ctx context.Context, in UpdateInput, turn Turn) (projectstore.Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := in.ID
	if id == "" {
		id = turn.TaskID
	}
	if id == "" {
		// The orchestrator states a goal for this request: that is a task (M6 rule 1).
		t, err := s.createTurnTask(ctx, in, turn)
		if err != nil {
			return t, err
		}
		id = t.ID
		turn.TaskID = id
	}
	t, err := s.DB.Task(ctx, id)
	if errors.Is(err, projectstore.ErrNotFound) {
		return t, bad("no task %q (see the task list in memory_search or the tasks API)", id)
	}
	if err != nil {
		return t, err
	}
	if id != turn.TaskID && turn.TaskID != "" && turn.MessageID != 0 {
		if !slices.Contains(t.MessageIDs, turn.MessageID) {
			t.MessageIDs = append(t.MessageIDs, turn.MessageID)
		}
		if cur, cerr := s.DB.Task(ctx, turn.TaskID); cerr == nil && cur.Auto {
			if err := s.DB.DeleteTask(ctx, cur.ID); err == nil {
				s.publish("task.updated", map[string]any{"task_id": cur.ID, "deleted": true})
			}
		}
	}
	if in.Status != nil {
		switch *in.Status {
		case projectstore.TaskOpen, projectstore.TaskDone, projectstore.TaskDropped:
			t.Status = *in.Status
		default:
			return t, bad("status must be open, done or dropped")
		}
	}
	if in.Title != nil && strings.TrimSpace(*in.Title) != "" {
		t.Title = clip(s.redact(strings.TrimSpace(*in.Title)), MaxTitle)
	}
	if in.Goal != nil && strings.TrimSpace(*in.Goal) != "" {
		t.Goal, t.GoalBy = clip(s.redact(strings.TrimSpace(*in.Goal)), MaxGoal), "orchestrator"
	}
	if in.Outcome != nil {
		t.Outcome = clip(s.redact(strings.TrimSpace(*in.Outcome)), MaxOutcome)
	}
	red := func(l []string) []string {
		out := make([]string, len(l))
		for i, v := range l {
			out[i] = s.redact(v)
		}
		return cleanList(out, MaxItem)
	}
	if t.Constraints, err = addUnique(t.Constraints, red(in.AddConstraints), MaxItems); err != nil {
		return t, err
	}
	if t.Acceptance, err = addUnique(t.Acceptance, red(in.AddAcceptance), MaxItems); err != nil {
		return t, err
	}
	if t.Decisions, err = addUnique(t.Decisions, red(in.AddDecisions), MaxItems); err != nil {
		return t, err
	}
	if t.Files, err = addUnique(t.Files, red(in.Files), MaxItems); err != nil {
		return t, err
	}
	if len(in.AddQuotes) > 0 {
		if err := s.addQuotes(&t, red(in.AddQuotes), turn.MessageID); err != nil {
			return t, err
		}
	}
	t.Auto = false
	t, err = s.DB.SaveTask(ctx, t)
	if err == nil {
		s.publish("task.updated", map[string]any{"task": t})
	}
	return t, err
}

// addQuotes keeps quotes that really are in the request text of messageID.
func (s *Service) addQuotes(t *projectstore.Task, quotes []string, messageID int64) error {
	text := ""
	if messageID != 0 {
		text, _, _, _, _ = s.DB.MessageText(context.Background(), messageID)
		text = s.redact(text)
	}
	for _, q := range quotes {
		if text != "" && !strings.Contains(text, q) {
			return bad("quote %q is not wording of the user's request (a quote must be exact; put paraphrases in a decision or the goal)", clip(q, 60))
		}
		if len(t.Quotes) >= MaxItems {
			return bad("a task record holds at most %d quotes", MaxItems)
		}
		dup := slices.ContainsFunc(t.Quotes, func(x projectstore.Quote) bool { return x.Text == q })
		if !dup {
			t.Quotes = append(t.Quotes, projectstore.Quote{Text: q, MessageID: messageID})
		}
	}
	return nil
}

// Candidates are the earlier tasks of this session a digest may attach a
// follow-up to: the open ones and the three most recently finished, newest
// first, at most 6. A task of another session is not offered (a new session is
// a new conversation); neither is a dropped one.
func (s *Service) Candidates(ctx context.Context, sessionID string) []projectstore.Task {
	tasks, err := s.DB.Tasks(ctx)
	if err != nil {
		return nil
	}
	var out []projectstore.Task
	done := 0
	for _, t := range tasks {
		if t.Status == projectstore.TaskDropped || t.SessionID != sessionID || t.Title == RememberedTaskTitle {
			continue
		}
		if t.Status == projectstore.TaskDone {
			if done++; done > 3 {
				continue
			}
		}
		if len(out) < 6 {
			out = append(out, t)
		}
	}
	return out
}
