package orchestrator_test

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakeacp"
	"github.com/ndolinschi/Octo/apps/harness/internal/memory"
	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

func tasksOf(t *testing.T, r *rig, pid string) []projectstore.Task {
	t.Helper()
	m, err := r.orch.Memory(context.Background(), pid)
	if err != nil {
		t.Fatal(err)
	}
	ts, err := m.Tasks(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// The Remembered record holds facts of turns that made no task; it is not a task of a turn.
	out := ts[:0]
	for _, x := range ts {
		if x.Title != memory.RememberedTaskTitle {
			out = append(out, x)
		}
	}
	return out
}

// eventually polls cond until it holds (the digest runs after the turn).
func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func digestRig(t *testing.T) *rig {
	return newRigWith(t, mockllm.New(0), orchestrator.Options{MemoryDigest: true})
}

func (r *rig) settle(t *testing.T, pid string) {
	t.Helper()
	eventually(t, "the turn to be over", func() bool { return !r.orch.Running(pid) })
	r.orch.WaitSettledForTest() // the digest is off the request path: wait for it, not for a fixed time
}

func exchangesOf(t *testing.T, r *rig, pid string) []projectstore.Exchange {
	t.Helper()
	m, err := r.orch.Memory(context.Background(), pid)
	if err != nil {
		t.Fatal(err)
	}
	ss, err := m.Sessions(context.Background(), 50, "")
	if err != nil {
		t.Fatal(err)
	}
	var out []projectstore.Exchange
	for _, s := range ss {
		d, err := m.Session(context.Background(), s.ID)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, d.Exchanges...)
	}
	return out
}

// Ten questions that were only answered create no task and ten exchanges (M6 rule 1), with
// the digest on (which even finds a goal and a fact in them) and with none.
func TestQuestionOnlyTurnsCreateNoTaskButKeepTheirExchanges(t *testing.T) {
	for name, opts := range map[string]orchestrator.Options{
		"with a digest": {MemoryDigest: true}, "without a digest": {},
	} {
		t.Run(name, func(t *testing.T) {
			r := newRigWith(t, mockllm.New(0), opts)
			pid := r.projectAt(t, t.TempDir())
			for i := 0; i < 10; i++ {
				text := fmt.Sprintf("quick: What is about this repo, round %d [goal: Know the repo] [fact: Repo note %d]", i, i)
				if st := r.run(t, pid, text, nil); st != "completed" {
					t.Fatalf("turn %d = %s", i, st)
				}
				r.settle(t, pid)
			}
			if ts := tasksOf(t, r, pid); len(ts) != 0 {
				t.Fatalf("tasks = %+v, want none", ts)
			}
			if ex := exchangesOf(t, r, pid); len(ex) != 10 {
				t.Fatalf("%d exchanges, want 10", len(ex))
			}
		})
	}
}

// A turn that delegates (it did work) makes one task with files and state, without a model.
func TestAWorkTurnMakesOneTaskWithStateAndFilesWithoutADigest(t *testing.T) {
	r := newRigWith(t, mockllm.New(0), orchestrator.Options{})
	pid := r.projectAt(t, t.TempDir())
	r.run(t, pid, "Please build it [write:notes/{role}.md]", nil)
	ts := tasksOf(t, r, pid)
	if len(ts) != 1 {
		t.Fatalf("tasks = %+v, want one", ts)
	}
	got := ts[0]
	var wrote bool
	for _, f := range got.Files {
		wrote = wrote || strings.HasPrefix(f, "notes/") && strings.HasSuffix(f, ".md")
	}
	if !wrote || got.Goal != "Build it [write:notes/{role}.md]" || got.GoalBy != "rule" || !strings.HasPrefix(got.StateSummary, "Did: ") ||
		got.Status != projectstore.TaskDone || got.ClosedReason != "turn completed" || got.Outcome == "" || len(got.ExchangeIDs) != 1 || got.SessionID == "" {
		t.Fatalf("task = %+v", got)
	}
}

// A follow-up joins the task it continues; a repeat of the request does not duplicate it.
func TestDigestAttachesAFollowUpToTheTaskItContinuesAndARepeatJoins(t *testing.T) {
	r := digestRig(t)
	pid := r.projectAt(t, t.TempDir())
	r.run(t, pid, "build a calculator [goal: A calculator] [state: Parser done, brackets left] [unmet] [constraint: no deps]", nil)
	eventually(t, "the first digest", func() bool { ts := tasksOf(t, r, pid); return len(ts) == 1 && ts[0].StateSummary != "" })
	first := tasksOf(t, r, pid)[0]
	if first.Status != projectstore.TaskOpen || !first.Unfinished || first.StateSummary != "Parser done, brackets left" || first.GoalBy != "digest" {
		t.Fatalf("first = %+v", first)
	}
	r.run(t, pid, "build brackets too [continues: calculator] [state: Brackets added] [met] [outcome: Brackets added]", nil)
	eventually(t, "the follow-up to join the first task", func() bool {
		ts := tasksOf(t, r, pid)
		return len(ts) == 1 && len(ts[0].MessageIDs) == 2 && ts[0].Status == projectstore.TaskDone
	})
	got := tasksOf(t, r, pid)[0]
	if got.ID != first.ID || got.ClosedReason != "goal met" || got.Outcome != "Brackets added" || got.StateSummary != "Brackets added" || got.Goal != "A calculator" || len(got.ExchangeIDs) != 2 {
		t.Fatalf("task = %+v", got)
	}
	r.run(t, pid, "build a calculator [goal: A calculator]", nil) // the same request again
	r.settle(t, pid)
	if ts := tasksOf(t, r, pid); len(ts) != 1 || len(ts[0].MessageIDs) != 3 {
		t.Fatalf("a repeat made a second task: %+v", ts)
	}
}

// A cancelled question leaves no task (it did nothing); its exchange says it was stopped.
func TestCancelledQuestionLeavesAStoppedExchangeAndNoTask(t *testing.T) {
	r := liveRigWith(t, 0)
	pid := r.acpOrchProject(t)
	got := r.runCollect(t, pid, "[say-hang] go", func(ch <-chan events.Event) {
		waitFor(t, ch, events.MessageDelta)
		r.orch.Cancel(pid)
	})
	if got.status != "cancelled" {
		t.Fatalf("status = %s", got.status)
	}
	if ts := tasksOf(t, r, pid); len(ts) != 0 {
		t.Fatalf("tasks = %+v, want none", ts)
	}
	if ex := exchangesOf(t, r, pid); len(ex) != 1 || ex[0].Status != projectstore.ExchangeStopped {
		t.Fatalf("exchanges = %+v", ex)
	}
}

// An ACP orchestrator without an API key: the digest cannot run on the built-in loop, so the
// agent is asked once in its live session after a turn that did work (and never after a question).
func noKeyACP(t *testing.T, env map[string]string) (*rig, string) {
	t.Helper()
	agent := fakeAgent("fake", true)
	for k, v := range env {
		agent.Launch.Env[k] = v
	}
	r := newRigWith(t, mockllm.New(0), orchestrator.Options{
		Agents: []plugins.Agent{agent}, MemoryDigest: true, BuiltinUnavailable: config.NoBuiltinLoopMessage,
	})
	name := "p"
	p, err := r.svcWithAgents(t, agent).Create(context.Background(), project.Input{
		Name: &name, Folders: &[]project.FolderInput{{Path: t.TempDir()}}, Models: &config.Models{Orchestrator: "acp:fake"},
	})
	if err != nil {
		t.Fatal(err)
	}
	return r, p.ID
}

func TestACPOrchestratorWithoutAKeyAsksItsAgentForTheDigestAfterWork(t *testing.T) {
	r, pid := noKeyACP(t, nil)
	r.run(t, pid, "[fswrite] write it [goal: Write the file] [state: File written, nothing left] [met] [acceptance: the file exists]", nil)
	eventually(t, "the agent's digest", func() bool { ts := tasksOf(t, r, pid); return len(ts) == 1 && ts[0].GoalBy == "digest" })
	got := tasksOf(t, r, pid)[0]
	if got.Goal != "Write the file" || got.StateSummary != "File written, nothing left" || got.Status != projectstore.TaskDone || got.ClosedReason != "goal met" ||
		len(got.Acceptance) != 1 || len(got.Files) == 0 {
		t.Fatalf("task = %+v", got)
	}
	// The digest prompt is not a user turn and its answer is not a message.
	db, _ := r.store.Get(context.Background(), pid)
	orch, _ := db.Orchestrator(context.Background())
	for _, m := range r.transcript(t, pid, orch.ID) {
		for _, b := range m.Content {
			if b.Text != nil && (strings.Contains(*b.Text, "You maintain the memory") || strings.Contains(*b.Text, `"goal_met"`)) {
				t.Fatalf("the digest exchange is in the transcript: %q (%s)", *b.Text, m.Role)
			}
		}
	}
	// A question afterwards: no task, no change.
	r.run(t, pid, "[echo] what is this? [goal: Understand] [constraint: none]", nil)
	r.settle(t, pid)
	if ts := tasksOf(t, r, pid); len(ts) != 1 {
		t.Fatalf("a question made a task: %+v", ts)
	}
}

func TestACPOrchestratorDigestFailureFallsBackToTheFactsTheHarnessHas(t *testing.T) {
	for _, mode := range []string{"fail", "garbage"} {
		t.Run(mode, func(t *testing.T) {
			r, pid := noKeyACP(t, map[string]string{fakeacp.EnvDigest: mode})
			r.run(t, pid, "Please write the file [fswrite] [goal: ignored]", nil)
			eventually(t, "the fallback record", func() bool { return len(tasksOf(t, r, pid)) == 1 })
			got := tasksOf(t, r, pid)[0]
			if got.GoalBy != "rule" || !strings.HasPrefix(got.Goal, "Write the file [fswrite]") || !strings.Contains(got.StateSummary, "changed 1 file") ||
				len(got.Files) == 0 || got.Status != projectstore.TaskDone || got.ClosedReason != "turn completed" {
				t.Fatalf("task = %+v", got)
			}
		})
	}
}

// The files the turn's tool calls read or changed are on its record.
func TestTaskRecordListsTheFilesTheTurnTouched(t *testing.T) {
	r := newRigWith(t, mockllm.New(0), orchestrator.Options{})
	pid := r.projectAt(t, t.TempDir())
	r.run(t, pid, "build it [write:notes/{role}.md]", nil)
	ts := tasksOf(t, r, pid)
	if len(ts) != 1 {
		t.Fatalf("tasks = %+v", ts)
	}
	var found bool
	for _, f := range ts[0].Files {
		found = found || strings.HasPrefix(f, "notes/") && strings.HasSuffix(f, ".md")
	}
	if !found {
		t.Fatalf("files = %v, want the written notes/<role>.md", ts[0].Files)
	}
}
