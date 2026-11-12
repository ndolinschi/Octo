package memory

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// Kinds of a remembered item.
var RememberKinds = []string{"fact", "decision", "preference", "todo"}

// RememberedTaskTitle is the record that holds items remembered outside a request's task
// (the user's /remember, or a call with no task open).
const RememberedTaskTitle = "Remembered"

// RememberInput is one item to keep as a dated fact.
type RememberInput struct {
	Text string
	Kind string
	// About names what the item is about; a new item of the same kind and subject replaces
	// the current one (the old fact stays, marked superseded).
	About string
	// By is the agent that remembered it ("user" for /remember); TaskID the task record of
	// the turn, MessageID the turn's request.
	By        string
	TaskID    string
	MessageID int64
}

// Remember stores in.Text as a dated fact of the turn's task record (or the Remembered record)
// with its source turn, kind, subject and author, superseding the earlier item about the same
// thing. It publishes task.updated and fact.remembered (turn, agent, fact) so a client can show
// "Remembered: ..." with an undo.
func (s *Service) Remember(ctx context.Context, in RememberInput) (projectstore.Fact, string, error) {
	text := clip(strings.TrimSpace(s.redact(in.Text)), MaxItem)
	if text == "" {
		return projectstore.Fact{}, "", bad("text is required")
	}
	if !slices.Contains(RememberKinds, in.Kind) {
		return projectstore.Fact{}, "", bad("kind must be one of %s", strings.Join(RememberKinds, ", "))
	}
	about := clip(strings.TrimSpace(s.redact(in.About)), 120)
	s.mu.Lock()
	defer s.mu.Unlock()
	t, err := s.rememberTask(ctx, in.TaskID)
	if err != nil {
		return projectstore.Fact{}, "", err
	}
	if len(t.Facts) >= MaxFacts {
		return projectstore.Fact{}, "", bad("the task record holds at most %d facts", MaxFacts)
	}
	for _, e := range t.Facts {
		if e.SupersededBy == "" && norm(e.Text) == norm(text) {
			return e, t.ID, nil // already known
		}
	}
	t.Auto = false // the record now holds something worth keeping: a trivial turn's cleanup must not delete it
	f := projectstore.Fact{ID: nextFactID(t.Facts), Text: text, Date: projectstore.Now(), MessageID: in.MessageID,
		Kind: in.Kind, About: about, RememberedBy: in.By}
	if about != "" {
		s.supersedeAbout(ctx, &t, f)
	}
	t.Facts = append(t.Facts, f)
	t, err = s.DB.SaveTask(ctx, t)
	if err != nil {
		return projectstore.Fact{}, "", err
	}
	s.publish("task.updated", map[string]any{"task": t})
	s.publish("fact.remembered", map[string]any{"task_id": t.ID, "fact": f, "turn_id": in.MessageID, "agent_id": in.By})
	return f, t.ID, nil
}

// supersedeAbout marks the current items of the same kind and subject as replaced by f
// (in t and in the other tasks).
func (s *Service) supersedeAbout(ctx context.Context, t *projectstore.Task, f projectstore.Fact) {
	match := func(e projectstore.Fact) bool {
		return e.SupersededBy == "" && e.Kind == f.Kind && e.About != "" && norm(e.About) == norm(f.About)
	}
	for i := range t.Facts {
		if match(t.Facts[i]) {
			t.Facts[i].SupersededBy = f.ID
		}
	}
	tasks, err := s.DB.Tasks(ctx)
	if err != nil {
		return
	}
	for _, o := range tasks {
		if o.ID == t.ID {
			continue
		}
		changed := false
		for i := range o.Facts {
			if match(o.Facts[i]) {
				o.Facts[i].SupersededBy = t.ID + "/" + f.ID
				changed = true
			}
		}
		if changed {
			if o, err = s.DB.SaveTask(ctx, o); err == nil {
				s.publish("task.updated", map[string]any{"task": o})
			}
		}
	}
}

// Forget deletes one fact (the undo of Remember); facts it had superseded become current again.
func (s *Service) Forget(ctx context.Context, taskID, factID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, err := s.DB.Task(ctx, taskID)
	if err != nil {
		return err
	}
	i := slices.IndexFunc(t.Facts, func(f projectstore.Fact) bool { return f.ID == factID })
	if i < 0 {
		return projectstore.ErrNotFound
	}
	t.Facts = slices.Delete(slices.Clone(t.Facts), i, i+1)
	ref := taskID + "/" + factID
	tasks, err := s.DB.Tasks(ctx)
	if err != nil {
		return err
	}
	for _, o := range tasks {
		if o.ID == t.ID {
			o = t
		}
		changed := o.ID == t.ID
		for j := range o.Facts {
			if by := o.Facts[j].SupersededBy; by == ref || (o.ID == taskID && by == factID) {
				o.Facts[j].SupersededBy = ""
				changed = true
			}
		}
		if !changed {
			continue
		}
		if o, err = s.DB.SaveTask(ctx, o); err != nil {
			return err
		}
		s.publish("task.updated", map[string]any{"task": o})
	}
	s.publish("fact.forgotten", map[string]any{"task_id": taskID, "fact_id": factID})
	return nil
}

func (s *Service) rememberTask(ctx context.Context, id string) (projectstore.Task, error) {
	if id != "" {
		t, err := s.DB.Task(ctx, id)
		if err == nil {
			return t, nil
		}
		if !errors.Is(err, projectstore.ErrNotFound) {
			return t, err
		}
	}
	tasks, err := s.DB.Tasks(ctx)
	if err != nil {
		return projectstore.Task{}, err
	}
	for _, t := range tasks {
		if t.Title == RememberedTaskTitle && !t.Auto {
			return t, nil
		}
	}
	return s.DB.CreateTask(ctx, projectstore.Task{Title: RememberedTaskTitle, Status: projectstore.TaskDone, GoalBy: "harness"})
}

func nextFactID(facts []projectstore.Fact) string {
	max := 0
	for _, f := range facts {
		if n, err := strconv.Atoi(strings.TrimPrefix(f.ID, "f")); err == nil && n > max {
			max = n
		}
	}
	return fmt.Sprintf("f%d", max+1)
}
