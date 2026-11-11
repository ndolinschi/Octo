package orchestrator_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/memory"
	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
)

func (r *rig) acpWindowProject(t *testing.T) string {
	t.Helper()
	name := "p"
	svc := r.svcWithAgents(t, fakeAgent("fake", true))
	p, err := svc.Create(context.Background(), project.Input{
		Name: &name, Folders: &[]project.FolderInput{{Path: t.TempDir()}},
		Models: &config.Models{Orchestrator: "acp:fake"}, Memory: &memory.Settings{Context: "window"},
	})
	if err != nil {
		t.Fatal(err)
	}
	return p.ID
}

func (r *rig) echoOf(t *testing.T, pid string, got collected) string {
	t.Helper()
	db, _ := r.store.Get(context.Background(), pid)
	orch, _ := db.Orchestrator(context.Background())
	msgs := r.transcript(t, pid, orch.ID)
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].Role == "assistant" {
			for _, b := range msgs[i].Content {
				if b.Type == "text" && b.Text != nil && strings.Contains(*b.Text, "prompt<<") {
					return *b.Text
				}
			}
		}
	}
	t.Fatal("no echo")
	return ""
}

func TestACPRecapUsesTheWindowAssemblyAndALiveSessionGetsChangedTasks(t *testing.T) {
	r := newACPRig(t, mockllm.New(0), fakeAgent("fake", true))
	pid := r.acpWindowProject(t)
	ctx := context.Background()
	db, _ := r.store.Get(ctx, pid)
	orch, _ := db.Orchestrator(ctx)
	mem, _ := r.orch.Memory(ctx, pid)
	for i := 1; i <= 9; i++ {
		for _, m := range []struct{ role, text string }{{"user", fmt.Sprintf("old request %d", i)}, {"assistant", fmt.Sprintf("old answer %d", i)}} {
			b, _ := json.Marshal([]map[string]any{{"type": "text", "text": m.text}})
			if _, err := db.AppendMessage(ctx, orch.ID, m.role, b); err != nil {
				t.Fatal(err)
			}
		}
	}
	// First turn of a fresh session: the assembled context, not the 40-text recap.
	got := r.runCollect(t, pid, "[echo] first", nil)
	first := r.echoOf(t, pid, got)
	for _, want := range []string{"assembled by the harness", "## Memory", "## Tasks", "## Recent exchanges", "old request 9", "old request 5", "User request:", "[echo] first>>"} {
		if !strings.Contains(first, want) {
			t.Errorf("first prompt lacks %q in %q", want, first[max(len(first)-1500, 0):])
		}
	}
	for _, not := range []string{"old request 4", "old request 1", "recap built by the harness"} {
		if strings.Contains(first, not) {
			t.Errorf("first prompt holds %q", not)
		}
	}
	rc := receiptOf(t, r, pid, "[echo] first")
	if rc.Mode != "window" || len(rc.Blocks) == 0 {
		t.Fatalf("receipt = %+v", rc)
	}
	for r.orch.Running(pid) {
		sleepMs(5)
	}
	// A task record changes while the session lives (the user or a digest edited it):
	// the next request of the same session carries it.
	tasks, _ := mem.Tasks(ctx)
	goal := "Ship the changed goal"
	if _, err := mem.UpdateTask(ctx, memory.UpdateInput{ID: tasks[0].ID, Goal: &goal}, memory.Turn{}); err != nil {
		t.Fatal(err)
	}
	got = r.runCollect(t, pid, "[echo] second", nil)
	second := r.echoOf(t, pid, got)
	if !strings.Contains(second, "Open task records that changed since your last turn") || !strings.Contains(second, goal) {
		t.Fatalf("second prompt = %q", second)
	}
	if strings.Contains(second, "## Recent exchanges") || strings.Contains(second, "assembled by the harness") {
		t.Errorf("a live session must not get the assembly again: %q", second)
	}
	rc = receiptOf(t, r, pid, "[echo] second")
	if len(rc.Blocks) != 2 || rc.Blocks[0].Name != "changed_tasks" {
		t.Fatalf("receipt of the live turn = %+v", rc)
	}
	// Nothing changed since: the third request carries no task block.
	for r.orch.Running(pid) {
		sleepMs(5)
	}
	got = r.runCollect(t, pid, "[echo] third", nil)
	if third := r.echoOf(t, pid, got); strings.Contains(third, "changed since your last turn") {
		t.Errorf("an unchanged task was sent again: %q", third)
	}
}

func receiptOf(t *testing.T, r *rig, pid, text string) orchestrator.Receipt {
	t.Helper()
	db, _ := r.store.Get(context.Background(), pid)
	orch, _ := db.Orchestrator(context.Background())
	for _, m := range r.transcript(t, pid, orch.ID) {
		if m.Role == "user" && len(m.Content) > 0 && m.Content[0].Text != nil && *m.Content[0].Text == text {
			raw, err := r.orch.TurnReceipt(context.Background(), pid, m.ID)
			if err != nil {
				t.Fatal(err)
			}
			var rc orchestrator.Receipt
			if err := json.Unmarshal(raw, &rc); err != nil {
				t.Fatal(err)
			}
			return rc
		}
	}
	t.Fatalf("no message %q", text)
	return orchestrator.Receipt{}
}
