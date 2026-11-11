package orchestrator_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
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
	return ts
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
	time.Sleep(300 * time.Millisecond) // the digest is off the request path
}

// A trivial exchange (no tool call, a short answer) leaves no task record, unless
// the digest finds something worth keeping in it; with no digest it leaves none.
func TestTrivialExchangesLeaveNoTaskRecord(t *testing.T) {
	t.Run("nothing durable", func(t *testing.T) {
		r := digestRig(t)
		pid := r.projectAt(t, t.TempDir())
		if st := r.run(t, pid, "quick: hello there", nil); st != "completed" {
			t.Fatalf("turn = %s", st)
		}
		r.settle(t, pid)
		if ts := tasksOf(t, r, pid); len(ts) != 0 {
			t.Fatalf("tasks = %+v, want none", ts)
		}
	})
	t.Run("a durable fact keeps the record, closed", func(t *testing.T) {
		r := digestRig(t)
		pid := r.projectAt(t, t.TempDir())
		r.run(t, pid, "quick: the port is 8791 [fact: The dev server port is 8791]", nil)
		eventually(t, "the digest", func() bool {
			ts := tasksOf(t, r, pid)
			return len(ts) == 1 && len(ts[0].Facts) == 1
		})
		if ts := tasksOf(t, r, pid); ts[0].Status != projectstore.TaskDone || ts[0].Outcome == "" {
			t.Fatalf("task = %+v", ts[0])
		}
	})
	t.Run("without a digest", func(t *testing.T) {
		r := newRigWith(t, mockllm.New(0), orchestrator.Options{})
		pid := r.projectAt(t, t.TempDir())
		r.run(t, pid, "quick: hello there", nil)
		if ts := tasksOf(t, r, pid); len(ts) != 0 {
			t.Fatalf("tasks = %+v, want none", ts)
		}
	})
	t.Run("a turn with tool calls is kept", func(t *testing.T) {
		r := newRigWith(t, mockllm.New(0), orchestrator.Options{})
		pid := r.projectAt(t, t.TempDir())
		r.run(t, pid, "build the thing", nil) // the orchestrator delegates: spawn_agent calls
		ts := tasksOf(t, r, pid)
		if len(ts) != 1 || ts[0].Status != projectstore.TaskDone || ts[0].Outcome == "" {
			t.Fatalf("tasks = %+v, want one done task with an outcome", ts)
		}
	})
}

// A follow-up joins the task it continues instead of opening another.
func TestDigestAttachesAFollowUpToTheTaskItContinues(t *testing.T) {
	r := digestRig(t)
	pid := r.projectAt(t, t.TempDir())
	r.run(t, pid, "quick: write a calculator [goal: A calculator] [fact: The calculator is a Go package]", nil)
	eventually(t, "the first digest", func() bool { ts := tasksOf(t, r, pid); return len(ts) == 1 && len(ts[0].Facts) == 1 })
	first := tasksOf(t, r, pid)[0]
	r.run(t, pid, "quick: also support brackets [continues: calculator] [fact: Brackets nest] [outcome: Brackets added]", nil)
	eventually(t, "the follow-up to join the first task", func() bool {
		ts := tasksOf(t, r, pid)
		return len(ts) == 1 && len(ts[0].MessageIDs) == 2
	})
	got := tasksOf(t, r, pid)[0]
	if got.ID != first.ID || got.Status != projectstore.TaskDone || got.Outcome != "Brackets added" || len(got.Facts) != 2 {
		t.Fatalf("task = %+v, want the first task, done, outcome from the follow-up, two facts", got)
	}
}

// A cancelled turn's record is dropped.
func TestCancelledTurnDropsItsTask(t *testing.T) {
	r := liveRigWith(t, 0)
	pid := r.acpOrchProject(t)
	got := r.runCollect(t, pid, "[say-hang] go", func(ch <-chan events.Event) {
		waitFor(t, ch, events.MessageDelta)
		r.orch.Cancel(pid)
	})
	if got.status != "cancelled" {
		t.Fatalf("status = %s", got.status)
	}
	ts := tasksOf(t, r, pid)
	if len(ts) != 1 || ts[0].Status != projectstore.TaskDropped {
		t.Fatalf("tasks = %+v, want one dropped", ts)
	}
}

// The files the turn's tool calls read or changed are on its record.
func TestTaskRecordListsTheFilesTheTurnTouched(t *testing.T) {
	t.Run("built-in tools", func(t *testing.T) {
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
	})
	t.Run("ACP locations", func(t *testing.T) {
		r := liveRigWith(t, 0)
		pid := r.acpOrchProject(t)
		r.run(t, pid, "[live] go", nil)
		ts := tasksOf(t, r, pid)
		if len(ts) != 1 || len(ts[0].Files) != 1 || ts[0].Files[0] != "README.md" {
			t.Fatalf("tasks = %+v, want files [README.md] (relative to the folder)", ts)
		}
	})
}
