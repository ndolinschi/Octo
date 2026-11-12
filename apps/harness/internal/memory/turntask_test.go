package memory

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

func TestGoalFromRequestRewritesByRule(t *testing.T) {
	for in, want := range map[string]string{
		"Can you please add a retry to the uploader?":      "Add a retry to the uploader",
		"please fix the login bug. It crashes on submit":   "Fix the login bug",
		"Пожалуйста, добавь кнопку выхода":                 "Добавь кнопку выхода",
		"What is about this repo":                          "What is about this repo",
		"  make the tests faster\nsecond line is ignored ": "Make the tests faster",
		"":   "",
		"hi": "",
	} {
		if got := projectstore.GoalFromRequest(in); got != want {
			t.Errorf("GoalFromRequest(%q) = %q, want %q", in, got, want)
		}
	}
}

// settle records the exchange of a turn, then settles it like the orchestrator does.
func (r *rig) settle(turn int64, request string, w TurnWork, d *Digest) Settled {
	r.t.Helper()
	r.exchange(turn, time.Now(), request, "answer", projectstore.ExchangeCompleted)
	sid, _ := r.db.SessionOfTurn(context.Background(), turn)
	w.MessageID, w.Request, w.SessionID, w.Completed = turn, request, sid, !w.Cancelled
	if w.Reply == "" {
		w.Reply = "Done."
	}
	s, err := r.svc.SettleTurn(context.Background(), w, d)
	if err != nil {
		r.t.Fatal(err)
	}
	return s
}

func (r *rig) tasks() []projectstore.Task {
	r.t.Helper()
	ts, err := r.db.Tasks(context.Background())
	if err != nil {
		r.t.Fatal(err)
	}
	return ts
}

func TestQuestionOnlyTurnsCreateNoTaskAndKeepTheirExchanges(t *testing.T) {
	r := newRig(t)
	for i := 1; i <= 10; i++ {
		// Even with a model digest that found only a goal and a fact: not a task.
		d := &Digest{Goal: "Know what the repo is", Facts: []DigestFact{{Text: fmt.Sprintf("The repo has %d crates", i)}}}
		if got := r.settle(int64(i*10), "What is about this repo", TurnWork{}, d); got.Has {
			t.Fatalf("turn %d made a task: %+v", i, got.Task)
		}
	}
	for _, task := range r.tasks() {
		if task.Title != RememberedTaskTitle {
			t.Fatalf("a question left a task: %+v", task)
		}
	}
	sessions, _ := r.svc.Sessions(context.Background(), 10, "")
	n := 0
	for _, s := range sessions {
		n += s.Exchanges
	}
	if n != 10 {
		t.Fatalf("exchanges = %d, want 10", n)
	}
}

func TestATurnThatEditsAFileMakesOneTaskWithFilesAndStateWithoutAModel(t *testing.T) {
	r := newRig(t)
	got := r.settle(10, "Can you please add a retry to the uploader?", TurnWork{Changed: []string{"src/upload.go"}, Touched: []string{"src/upload.go", "README.md"}}, nil)
	if !got.Has || got.Joined {
		t.Fatalf("settled = %+v", got)
	}
	task := got.Task
	if task.Goal != "Add a retry to the uploader" || task.GoalBy != "rule" || task.Title != "Add a retry to the uploader" {
		t.Fatalf("goal = %q by %q title %q", task.Goal, task.GoalBy, task.Title)
	}
	if strings.Join(task.Files, ",") != "src/upload.go,README.md" || !strings.Contains(task.StateSummary, "changed 1 file (src/upload.go)") {
		t.Fatalf("files %v state %q", task.Files, task.StateSummary)
	}
	if task.Status != "done" || task.ClosedReason != "turn completed" || task.SessionID == "" || len(task.ExchangeIDs) != 1 {
		t.Fatalf("task = %+v", task)
	}
	if len(r.tasks()) != 1 {
		t.Fatalf("tasks = %+v", r.tasks())
	}
}

func TestAFollowUpJoinsAndARepeatDoesNotDuplicate(t *testing.T) {
	r := newRig(t)
	first := r.settle(10, "Add a retry to the uploader", TurnWork{Changed: []string{"a.go"}}, &Digest{Goal: "Add a retry to the uploader", State: "Retry added, tests left", GoalMet: ptrBool(false)})
	if first.Task.Status != "open" || first.Task.StateSummary != "Retry added, tests left" || !first.Task.Unfinished {
		t.Fatalf("first = %+v", first.Task)
	}
	// A follow-up the digest says continues it joins; the goal stays, the state is the newest.
	second := r.settle(20, "now add the tests", TurnWork{Changed: []string{"a_test.go"}},
		&Digest{Goal: "Test the retry", State: "Tests added", Continues: first.Task.ID, GoalMet: ptrBool(true)})
	if !second.Joined || second.Task.ID != first.Task.ID || second.Task.Goal != "Add a retry to the uploader" ||
		second.Task.Status != "done" || second.Task.ClosedReason != "goal met" || len(second.Task.MessageIDs) != 2 {
		t.Fatalf("second = %+v", second.Task)
	}
	if strings.Join(second.Task.Files, ",") != "a.go,a_test.go" || len(second.Task.ExchangeIDs) != 2 {
		t.Fatalf("files %v exchanges %v", second.Task.Files, second.Task.ExchangeIDs)
	}
	// The same request again (no continues): the title repeats, so it joins instead of duplicating.
	third := r.settle(30, "Add a retry to the uploader", TurnWork{Changed: []string{"a.go"}}, &Digest{Goal: "Add a retry to the uploader"})
	if !third.Joined || third.Task.ID != first.Task.ID || len(r.tasks()) != 1 {
		t.Fatalf("a repeat made a second task: %+v", r.tasks())
	}
	// A new goal in the same session starts a new task.
	other := r.settle(40, "rename the module", TurnWork{Changed: []string{"go.mod"}}, &Digest{Goal: "Rename the module"})
	if other.Joined || other.Task.ID == first.Task.ID || len(r.tasks()) != 2 {
		t.Fatalf("a new goal joined: %+v", other.Task)
	}
}

func TestADigestGoalWithAConstraintMakesATaskWithoutWork(t *testing.T) {
	r := newRig(t)
	if got := r.settle(10, "stay within budget", TurnWork{}, &Digest{Goal: "Stay within budget"}); got.Has {
		t.Fatalf("a goal alone made a task: %+v", got.Task)
	}
	for i, d := range []*Digest{
		{Goal: "Stay within budget", Constraints: []string{"under $5"}}, {Goal: "Ship v2", Acceptance: []string{"CI green"}},
		{Goal: "Pick a database", Decisions: []string{"use SQLite"}}, {Goal: "Choose a name", OpenQuestions: []string{"which name?"}},
	} {
		if got := r.settle(int64(20+i*10), fmt.Sprintf("request %d", i), TurnWork{}, d); !got.Has {
			t.Fatalf("digest %d made no task", i)
		}
	}
	if got := r.tasks()[0]; got.Unfinished == false && len(got.OpenQuestions) == 0 {
		t.Fatalf("a task with an open question must be unfinished: %+v", got)
	}
}

func TestPlanAndSubAgentsCountAsWorkAndCommandsOnlyWhenTheyChangeState(t *testing.T) {
	r := newRig(t)
	for i, w := range []TurnWork{{Plan: true}, {SubAgents: []string{"tester"}}, {Commands: 1}} {
		if !r.settle(int64(10*(i+1)), fmt.Sprintf("job %d", i), w, nil).Has {
			t.Fatalf("work %+v made no task", w)
		}
	}
	if (TurnWork{}).DidWork() {
		t.Fatal("nothing is not work")
	}
}

func TestFailedAndStoppedWorkTurns(t *testing.T) {
	r := newRig(t)
	r.exchange(10, time.Now(), "build the thing", "", projectstore.ExchangeFailed)
	sid, _ := r.db.SessionOfTurn(context.Background(), 10)
	failed2, err := r.svc.SettleTurn(context.Background(), TurnWork{MessageID: 10, Request: "build the thing", Changed: []string{"x.go"}, SessionID: sid}, nil)
	if err != nil || failed2.Task.Status != "open" || !failed2.Task.Unfinished || !strings.Contains(failed2.Task.StateSummary, "failed") {
		t.Fatalf("a failed turn must stay open and say so: %+v", failed2.Task)
	}
	stopped := r.settle(20, "other thing", TurnWork{Changed: []string{"y.go"}, Cancelled: true}, nil)
	if stopped.Task.Status != "dropped" || stopped.Task.ClosedReason != "stopped" {
		t.Fatalf("stopped = %+v", stopped.Task)
	}
}

func TestTheOrchestratorsTaskUpdateIsATaskAndRememberedItemsAttachToIt(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	m := r.say("user", "Use port 8791")
	r.exchange(m.ID, time.Now(), "Use port 8791", "ok", projectstore.ExchangeCompleted)
	// remember before any task exists: it lands in the Remembered record
	if _, _, err := r.svc.Remember(ctx, RememberInput{Text: "Dev port is 8791", Kind: "fact", About: "dev port", By: "orch", MessageID: m.ID}); err != nil {
		t.Fatal(err)
	}
	title := "Fix the port"
	task, err := r.svc.UpdateTask(ctx, UpdateInput{Title: &title}, Turn{MessageID: m.ID})
	if err != nil || task.Auto || task.Goal != "Use port 8791" || task.GoalBy != "rule" {
		t.Fatalf("task_update made %+v %v", task, err)
	}
	sid, _ := r.db.SessionOfTurn(ctx, m.ID)
	got, err := r.svc.SettleTurn(ctx, TurnWork{MessageID: m.ID, Request: "Use port 8791", Reply: "ok", Completed: true, TaskID: task.ID, SessionID: sid}, nil)
	if err != nil || !got.Has || got.Task.ID != task.ID || len(got.Task.Facts) != 1 || got.Task.Facts[0].Text != "Dev port is 8791" || len(got.Task.ExchangeIDs) != 1 {
		t.Fatalf("settled = %+v %v", got, err)
	}
	for _, o := range r.tasks() {
		if o.Title == RememberedTaskTitle && len(o.Facts) != 0 {
			t.Fatalf("the remembered item stayed behind: %+v", o)
		}
	}
}

func TestOpenTasksGoStaleAfterSevenDaysAndClearClosesOnlyFinishedOnes(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	a := r.settle(10, "old job", TurnWork{Changed: []string{"a.go"}}, &Digest{Goal: "Old job", GoalMet: ptrBool(false)})
	b := r.settle(20, "unfinished job", TurnWork{Changed: []string{"b.go"}}, &Digest{Goal: "Unfinished job", OpenQuestions: []string{"which db?"}})
	c := r.settle(30, "quiet job", TurnWork{Changed: []string{"c.go"}}, &Digest{Goal: "Quiet job"})
	// reopen c without an unfinished flag, as the user can
	open := "open"
	if _, err := r.svc.UpdateTask(ctx, UpdateInput{ID: c.Task.ID, Status: &open}, Turn{}); err != nil {
		t.Fatal(err)
	}
	if n := r.svc.CloseOnClear(ctx); n != 1 {
		t.Fatalf("clear closed %d, want 1 (the finished one)", n)
	}
	got := map[string]projectstore.Task{}
	for _, task := range r.tasks() {
		got[task.ID] = task
	}
	if got[c.Task.ID].Status != "done" || got[c.Task.ID].ClosedReason != "cleared" || got[b.Task.ID].Status != "open" || got[a.Task.ID].Status != "open" {
		t.Fatalf("after clear: a=%+v b=%+v c=%+v", got[a.Task.ID].Status, got[b.Task.ID].Status, got[c.Task.ID].Status)
	}
	// Seven days later (injected clock): the open ones are dropped, with the reason; nothing is dropped a day before.
	r.svc.Now = func() time.Time { return time.Now().Add(6*24*time.Hour + 23*time.Hour) }
	if n := r.svc.ExpireStale(ctx); n != 0 {
		t.Fatalf("dropped %d tasks before 7 days", n)
	}
	r.svc.Now = func() time.Time { return time.Now().Add(7*24*time.Hour + time.Minute) }
	if n := r.svc.ExpireStale(ctx); n != 2 {
		t.Fatalf("dropped %d tasks, want 2", n)
	}
	for _, task := range r.tasks() {
		if task.ID == c.Task.ID {
			continue
		}
		if task.Status != "dropped" || task.ClosedReason != "dropped: no activity" {
			t.Fatalf("task after 7 days = %+v", task)
		}
	}
}

func TestADigestFromAnotherSessionCannotBeJoined(t *testing.T) {
	r := newRig(t)
	first := r.settle(10, "Add a retry", TurnWork{Changed: []string{"a.go"}}, &Digest{Goal: "Add a retry"})
	if _, err := r.svc.StartSession(context.Background(), "clear"); err != nil {
		t.Fatal(err)
	}
	second := r.settle(20, "Add a retry", TurnWork{Changed: []string{"a.go"}}, &Digest{Goal: "Add a retry", Continues: first.Task.ID})
	if second.Joined || second.Task.ID == first.Task.ID || second.Task.SessionID == first.Task.SessionID {
		t.Fatalf("a new session joined an old task: %+v / %+v", first.Task, second.Task)
	}
}

func ptrBool(b bool) *bool { return &b }

// A fact the harness learnt has no subject of its own; the Knowledge view groups by subject, so without a rule almost
// everything would sit under "General". The fact is about its task; a subject from the digest wins; the Remembered
// record's facts stay subject-less.
func TestDigestFactsAreAboutTheirTaskUnlessTheDigestSaysOtherwise(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	d := &Digest{Goal: "Set up the dev server", State: "Server runs", Facts: []DigestFact{
		{Text: "The dev server port is 8790"},
		{Text: "CI runs on Rust 1.88", About: "CI"},
	}}
	got := r.settle(10, "Set up the dev server", TurnWork{Commands: 1}, d)
	if !got.Has {
		t.Fatal("no task was made")
	}
	task, err := r.db.Task(ctx, got.Task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(task.Facts) != 2 || task.Facts[0].About != task.Title || task.Facts[1].About != "CI" {
		t.Fatalf("facts = %+v, task title %q", task.Facts, task.Title)
	}
	// A question-only turn: its facts go to the Remembered record, which has no subject.
	q := &Digest{Goal: "Know the repo", Facts: []DigestFact{{Text: "The repo has 4 crates"}}}
	r.settle(20, "What is in this repo", TurnWork{}, q)
	for _, tk := range r.tasks() {
		if tk.Title != RememberedTaskTitle {
			continue
		}
		for _, f := range tk.Facts {
			if f.About != "" {
				t.Fatalf("a Remembered fact got a subject: %+v", f)
			}
		}
	}
}
