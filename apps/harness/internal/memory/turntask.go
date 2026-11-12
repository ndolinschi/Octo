package memory

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// StaleAfter is how long an open task may go without activity before it is
// dropped ("dropped: no activity").
const StaleAfter = 7 * 24 * time.Hour

// Closing reasons shown on a done or dropped task.
const (
	ReasonGoalMet     = "goal met"
	ReasonCompleted   = "turn completed"
	ReasonCleared     = "cleared"
	ReasonStopped     = "stopped"
	ReasonOrchestrate = "closed by the orchestrator"
	ReasonNoActivity  = "dropped: no activity"
)

// TurnWork is what the harness knows about a finished turn without asking a
// model: the facts that decide whether the turn did work (M6 rule 1).
type TurnWork struct {
	MessageID int64
	// SessionID is the memory session of the turn's exchange ("" when unknown).
	SessionID      string
	Request, Reply string
	// Changed are the paths the changes ledger recorded for the turn; Touched
	// the files the turn's tool calls read or changed.
	Changed, Touched []string
	// Commands counts commands that can change state (a read-only listing does not count).
	Commands  int
	SubAgents []string
	// Plan: the turn produced a plan, or carried out an approved one.
	Plan                 bool
	Completed, Cancelled bool
	// TaskID is the record the orchestrator's own task_update made this turn.
	TaskID string
}

// DidWork: it changed files, ran a state-changing command, delegated to a
// sub-agent or produced or approved a plan. A question that was only answered
// did none of these.
func (w TurnWork) DidWork() bool {
	return len(w.Changed) > 0 || w.Commands > 0 || len(w.SubAgents) > 0 || w.Plan
}

// Observed describes what the turn did, in a line (for the digest prompt and the fallback state).
func (w TurnWork) Observed() string {
	var parts []string
	if n := len(w.Changed); n > 0 {
		parts = append(parts, fmt.Sprintf("changed %s", plural(n, "file")+" ("+strings.Join(head(w.Changed, 5), ", ")+")"))
	}
	if w.Commands > 0 {
		parts = append(parts, "ran "+plural(w.Commands, "state-changing command"))
	}
	if n := len(w.SubAgents); n > 0 {
		parts = append(parts, "delegated to "+plural(n, "sub-agent")+" ("+strings.Join(head(w.SubAgents, 4), ", ")+")")
	}
	if w.Plan {
		parts = append(parts, "produced or followed a plan")
	}
	if len(parts) == 0 {
		return "nothing: no file changed, no state-changing command, no sub-agent, no plan"
	}
	return strings.Join(parts, "; ")
}

func plural(n int, word string) string {
	if n == 1 {
		return "1 " + word
	}
	return fmt.Sprintf("%d %ss", n, word)
}

func head(l []string, n int) []string {
	if len(l) > n {
		return append(slices.Clone(l[:n]), fmt.Sprintf("+%d more", len(l)-n))
	}
	return l
}

// Settled is what SettleTurn did.
type Settled struct {
	// Task is the record the turn created or joined; zero when the turn left none.
	Task   projectstore.Task
	Has    bool
	Joined bool
}

func (w TurnWork) goalStated(d *Digest) bool {
	return d != nil && strings.TrimSpace(d.Goal) != "" &&
		len(d.Constraints)+len(d.Acceptance)+len(d.Decisions)+len(d.OpenQuestions) > 0
}

// SettleTurn is the end of a turn for the task list (M6). A task is made or
// joined only when the turn did work, the orchestrator set a goal with
// task_update, or the digest states a goal with a constraint, an acceptance
// criterion, a decision or an open question; otherwise the exchange is the
// record and the digest's facts (if any) go to the Remembered record. d is nil
// when no model digested the turn: the record is then built from the facts the
// harness has (goal rewritten by rule, state from the changes ledger). A
// follow-up joins the digest's `continues` task of the same session, else a
// task of the session with the same title; it never makes a second task with
// the title of one.
func (s *Service) SettleTurn(ctx context.Context, w TurnWork, d *Digest) (Settled, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var cur *projectstore.Task
	if w.TaskID != "" {
		if t, err := s.DB.Task(ctx, w.TaskID); err == nil {
			cur = &t
		}
	}
	if cur == nil && !w.DidWork() && !w.goalStated(d) {
		if d != nil && len(d.Facts) > 0 {
			s.holdFacts(ctx, w.MessageID, d.Facts)
		}
		return Settled{}, nil
	}
	var dig Digest
	if d != nil {
		dig = *d
	}
	target, joined := cur, false
	if target == nil {
		target, joined = s.joinTarget(ctx, w, dig)
	}
	if target == nil {
		t, err := s.DB.CreateTask(ctx, projectstore.Task{
			Title: s.titleFor(w, dig), Status: projectstore.TaskOpen, GoalBy: "rule", Auto: true,
			SessionID: w.SessionID, MessageIDs: []int64{w.MessageID},
		})
		if err != nil {
			return Settled{}, err
		}
		target = &t
	}
	t := *target
	if joined {
		dig.Goal = "" // a follow-up does not rewrite the task's goal
	}
	s.fill(ctx, &t, w, dig, d != nil, joined, cur != nil)
	t, err := s.DB.SaveTask(ctx, t)
	if err != nil {
		return Settled{}, err
	}
	if w.MessageID != 0 {
		if _, err := s.DB.AttachExchangeTask(ctx, w.MessageID, t.ID); err != nil {
			return Settled{}, err
		}
	}
	s.adoptRemembered(ctx, &t, w.MessageID)
	if full, err := s.DB.Task(ctx, t.ID); err == nil {
		t = full
	}
	s.publish("task.updated", map[string]any{"task": t})
	return Settled{Task: t, Has: true, Joined: joined}, nil
}

func (s *Service) titleFor(w TurnWork, d Digest) string {
	g := strings.TrimSpace(s.redact(d.Goal))
	if g == "" {
		g = projectstore.GoalFromRequest(s.redact(w.Request))
	}
	if g = strings.Join(strings.Fields(g), " "); g == "" {
		return "Request"
	}
	return clip(g, 80)
}

// joinTarget finds the task a follow-up joins: the digest's `continues` (same
// session, not dropped), else a task of the session with the same title.
func (s *Service) joinTarget(ctx context.Context, w TurnWork, d Digest) (*projectstore.Task, bool) {
	if c := strings.TrimSpace(d.Continues); c != "" {
		if t, err := s.DB.Task(ctx, c); err == nil && t.Status != projectstore.TaskDropped && t.SessionID == w.SessionID {
			return &t, true
		}
	}
	tasks, err := s.DB.Tasks(ctx)
	if err != nil {
		return nil, false
	}
	title := norm(s.titleFor(w, d))
	for _, t := range tasks {
		if t.SessionID == w.SessionID && t.Status != projectstore.TaskDropped && t.Title != RememberedTaskTitle && norm(t.Title) == title {
			return &t, true
		}
	}
	return nil, false
}

// fill sets goal, state, files, lists and the status of t from the turn. s.mu is held.
func (s *Service) fill(ctx context.Context, t *projectstore.Task, w TurnWork, d Digest, digested, joined, own bool) {
	if !slices.Contains(t.MessageIDs, w.MessageID) && w.MessageID != 0 {
		t.MessageIDs = append(t.MessageIDs, w.MessageID)
	}
	if t.SessionID == "" {
		t.SessionID = w.SessionID
	}
	if strings.TrimSpace(t.Goal) == "" {
		if g := projectstore.GoalFromRequest(s.redact(w.Request)); g != "" {
			t.Goal, t.GoalBy = g, "rule"
		}
	}
	reply := strings.TrimSpace(s.redact(w.Reply))
	if digested {
		s.applyDigest(ctx, t, w.MessageID, d)
	}
	files := make([]string, 0, len(w.Changed)+len(w.Touched))
	for _, f := range append(slices.Clone(w.Changed), w.Touched...) {
		files = append(files, s.redact(f))
	}
	t.Files, _ = addUnique(t.Files, cleanList(files, MaxItem), MaxItems)

	state := clip(strings.TrimSpace(s.redact(d.State)), MaxGoal)
	if state == "" {
		state = s.fallbackState(w)
	}
	t.StateSummary = state
	if digested {
		qs := make([]string, 0, len(d.OpenQuestions))
		for _, q := range d.OpenQuestions {
			qs = append(qs, s.redact(q))
		}
		t.OpenQuestions = cleanList(qs, MaxItem)
	}
	gaveOutcome := false
	if o := strings.TrimSpace(s.redact(d.Outcome)); o != "" && (t.Outcome == "" || joined) {
		t.Outcome, gaveOutcome = clip(o, MaxOutcome), true
	}
	unfinished := len(t.OpenQuestions) > 0 || (d.GoalMet != nil && !*d.GoalMet) || strings.HasSuffix(reply, "?")
	switch {
	case w.Cancelled:
		if t.Status == projectstore.TaskOpen {
			t.Status, t.ClosedReason = projectstore.TaskDropped, ReasonStopped
		}
	case !w.Completed:
		t.Status, t.ClosedReason, t.Unfinished = projectstore.TaskOpen, "", true
		if !strings.Contains(t.StateSummary, "failed") {
			t.StateSummary = strings.TrimSpace(t.StateSummary + " The turn failed before it finished.")
		}
	case own && t.Status != projectstore.TaskOpen:
		// the orchestrator closed its own task_update record
		if t.ClosedReason == "" {
			t.ClosedReason = ReasonOrchestrate
		}
	case unfinished:
		t.Status, t.ClosedReason, t.Unfinished = projectstore.TaskOpen, "", true
	default:
		t.Status, t.Unfinished = projectstore.TaskDone, false
		t.ClosedReason = ReasonCompleted
		if d.GoalMet != nil && *d.GoalMet {
			t.ClosedReason = ReasonGoalMet
		}
		if t.Outcome == "" || (joined && !gaveOutcome) {
			t.Outcome = clip(reply, 300)
		}
	}
}

// fallbackState builds the state from the facts the harness has (no model).
func (s *Service) fallbackState(w TurnWork) string {
	st := "Did: " + w.Observed() + "."
	if w.Cancelled {
		st += " Stopped by the user before it finished."
	}
	return st
}

// holdFacts keeps the facts of a turn that made no task in the Remembered
// record (they stay searchable). s.mu is held.
func (s *Service) holdFacts(ctx context.Context, messageID int64, facts []DigestFact) {
	t, err := s.rememberTask(ctx, "")
	if err != nil {
		return
	}
	before := len(t.Facts)
	s.applyFacts(ctx, &t, messageID, facts)
	if len(t.Facts) == before {
		return
	}
	t.Auto = false
	if t, err = s.DB.SaveTask(ctx, t); err == nil {
		s.publish("task.updated", map[string]any{"task": t})
	}
}

// adoptRemembered moves the items the orchestrator remembered during the turn
// (kept in the Remembered record while the turn had no task) onto the turn's
// task (rule 4). Links from other facts to a moved one are rewritten. s.mu is held.
func (s *Service) adoptRemembered(ctx context.Context, t *projectstore.Task, messageID int64) {
	if messageID == 0 {
		return
	}
	tasks, err := s.DB.Tasks(ctx)
	if err != nil {
		return
	}
	var held *projectstore.Task
	for i := range tasks {
		if tasks[i].Title == RememberedTaskTitle && tasks[i].ID != t.ID {
			held = &tasks[i]
			break
		}
	}
	if held == nil {
		return
	}
	local := map[string]string{} // held fact id -> new fact id on t
	var rest, adopted []projectstore.Fact
	for _, f := range held.Facts {
		if f.MessageID != messageID || f.RememberedBy == "" || f.RememberedBy == "user" || len(t.Facts)+len(adopted) >= MaxFacts {
			rest = append(rest, f)
			continue
		}
		old := f.ID
		f.ID = nextFactID(append(slices.Clone(t.Facts), adopted...))
		local[old] = f.ID
		adopted = append(adopted, f)
	}
	if len(adopted) == 0 {
		return
	}
	for i := range adopted {
		switch by := adopted[i].SupersededBy; {
		case by == "":
		case strings.Contains(by, "/"):
		case local[by] != "":
			adopted[i].SupersededBy = local[by]
		default: // superseded by a fact that stayed in the Remembered record
			adopted[i].SupersededBy = held.ID + "/" + by
		}
	}
	t.Facts = append(t.Facts, adopted...)
	held.Facts = rest
	for i := range held.Facts { // a fact that stayed, superseded by one that moved
		if by := held.Facts[i].SupersededBy; local[by] != "" && !strings.Contains(by, "/") {
			held.Facts[i].SupersededBy = t.ID + "/" + local[by]
		}
	}
	for _, o := range otherTasks(tasks, held.ID, t.ID) { // facts of other tasks that point at a moved fact
		changed := false
		for i := range o.Facts {
			if by, ok := strings.CutPrefix(o.Facts[i].SupersededBy, held.ID+"/"); ok && local[by] != "" {
				o.Facts[i].SupersededBy, changed = t.ID+"/"+local[by], true
			}
		}
		if changed {
			if saved, err := s.DB.SaveTask(ctx, *o); err == nil {
				s.publish("task.updated", map[string]any{"task": saved})
			}
		}
	}
	if saved, err := s.DB.SaveTask(ctx, *held); err == nil {
		s.publish("task.updated", map[string]any{"task": saved})
	}
	if saved, err := s.DB.SaveTask(ctx, *t); err == nil {
		*t = saved
	}
}

func otherTasks(all []projectstore.Task, skip ...string) []*projectstore.Task {
	var out []*projectstore.Task
	for i := range all {
		if !slices.Contains(skip, all[i].ID) {
			out = append(out, &all[i])
		}
	}
	return out
}

// createTurnTask makes the record for a task_update of a turn that has none
// yet: the orchestrator stating a goal is a task. s.mu is held.
func (s *Service) createTurnTask(ctx context.Context, in UpdateInput, turn Turn) (projectstore.Task, error) {
	request := ""
	if turn.MessageID != 0 {
		request, _, _, _, _ = s.DB.MessageText(ctx, turn.MessageID)
	}
	goal := projectstore.GoalFromRequest(s.redact(request))
	title := goal
	if in.Title != nil && strings.TrimSpace(*in.Title) != "" {
		title = strings.TrimSpace(*in.Title)
	}
	if title = clip(s.redact(strings.Join(strings.Fields(title), " ")), MaxTitle); title == "" {
		title = "Request"
	}
	t := projectstore.Task{Title: title, Status: projectstore.TaskOpen, Goal: goal, GoalBy: "rule", Auto: true}
	if turn.MessageID != 0 {
		t.MessageIDs = []int64{turn.MessageID}
		if sid, err := s.DB.SessionOfTurn(ctx, turn.MessageID); err == nil {
			t.SessionID = sid
		}
	}
	return s.DB.CreateTask(ctx, t)
}

// ExpireStale drops the open tasks nobody touched for StaleAfter, with the
// reason "dropped: no activity". It returns how many it dropped.
func (s *Service) ExpireStale(ctx context.Context) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	tasks, err := s.DB.Tasks(ctx)
	if err != nil {
		return 0
	}
	cutoff := projectstore.Stamp(s.now().Add(-StaleAfter))
	n := 0
	for _, t := range tasks {
		if t.Status != projectstore.TaskOpen || t.UpdatedAt >= cutoff {
			continue
		}
		t.Status, t.ClosedReason = projectstore.TaskDropped, ReasonNoActivity
		if t, err = s.DB.SaveTask(ctx, t); err == nil {
			n++
			s.publish("task.updated", map[string]any{"task": t})
		}
	}
	return n
}

// CloseOnClear closes the open tasks that nothing leaves unfinished when the
// conversation is cleared ("cleared"); an unfinished one stays open and is
// carried by title. It returns how many it closed.
func (s *Service) CloseOnClear(ctx context.Context) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	tasks, err := s.DB.Tasks(ctx)
	if err != nil {
		return 0
	}
	n := 0
	for _, t := range tasks {
		if t.Status != projectstore.TaskOpen || t.Unfinished || len(t.OpenQuestions) > 0 {
			continue
		}
		t.Status, t.ClosedReason = projectstore.TaskDone, ReasonCleared
		if t, err = s.DB.SaveTask(ctx, t); err == nil {
			n++
			s.publish("task.updated", map[string]any{"task": t})
		}
	}
	return n
}
