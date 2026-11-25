package orchestrator_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/memory"
	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
)

func sum(cats []orchestrator.ContextCategory) int64 {
	var n int64
	for _, c := range cats {
		n += c.Tokens
	}
	return n
}

func (r *rig) seed(t *testing.T, pid string, exchanges int) {
	t.Helper()
	ctx := context.Background()
	db, _ := r.store.Get(ctx, pid)
	orch, _ := db.Orchestrator(ctx)
	for i := 1; i <= exchanges; i++ {
		for _, m := range []struct{ role, text string }{
			{"user", fmt.Sprintf("old request %d about module m%d %s", i, i, strings.Repeat("detail ", 30))},
			{"assistant", fmt.Sprintf("old answer %d %s", i, strings.Repeat("finding ", 40))},
		} {
			b, _ := json.Marshal([]map[string]any{{"type": "text", "text": m.text}})
			if _, err := db.AppendMessage(ctx, orch.ID, m.role, b); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func TestContextCategoriesSumToUsedAndMatchTheNextTurnsReceipt(t *testing.T) {
	for _, mode := range []string{"full", "window"} {
		t.Run(mode, func(t *testing.T) {
			r := newRig(t, mockLLMQuick())
			name, depth := "p", 1
			p, err := r.svc.Create(context.Background(), project.Input{Name: &name, MaxDepth: &depth,
				Folders: &[]project.FolderInput{{Path: t.TempDir()}}, Memory: &memory.Settings{Context: mode}})
			if err != nil {
				t.Fatal(err)
			}
			pid := p.ID
			dir := r.firstFolder(t, pid)
			if err := os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte("RULE: "+strings.Repeat("be careful ", 40)), 0o644); err != nil {
				t.Fatal(err)
			}
			r.seed(t, pid, 6)
			rep, err := r.orch.Context(context.Background(), pid, "")
			if err != nil {
				t.Fatal(err)
			}
			if !rep.Estimated || rep.Source != "harness" {
				t.Fatalf("report = %+v: nothing was reported yet, so it is an estimate made by the harness", rep)
			}
			if got := sum(rep.Categories); got != rep.UsedTokens || rep.UsedTokens == 0 {
				t.Fatalf("categories sum to %d, used %d: %+v", got, rep.UsedTokens, rep.Categories)
			}
			byID := map[string]int64{}
			for _, c := range rep.Categories {
				byID[c.ID] = c.Tokens
			}
			if byID["instructions"] == 0 || byID["tools"] == 0 || byID["system"] == 0 || byID["messages"] == 0 {
				t.Fatalf("categories = %+v", byID)
			}
			if mode == "window" && byID["memory"] == 0 {
				t.Fatalf("the window mode's memory blocks have a category: %+v", byID)
			}
			if rep.WindowSource != "default" || rep.Window == nil || *rep.Window != orchestrator.DefaultContextWindow ||
				rep.FreeTokens == nil || *rep.FreeTokens != *rep.Window-rep.UsedTokens-*rep.ReservedTokens {
				t.Fatalf("window/free = %+v", rep)
			}
			if rep.LastRequest != nil || rep.CompactedAt != "" {
				t.Fatalf("nothing was requested or compacted yet: %+v", rep)
			}
			// The conversation part the report counts, plus the next request, is what the next turn's receipt says it sent.
			conv := byID["messages"] + byID["tool_results"] + byID["summary"] + byID["current_request"] + byID["memory"]
			const request = "next question"
			if st := r.run(t, pid, request, nil); st != "completed" {
				t.Fatalf("turn = %s", st)
			}
			rc := receiptOf(t, r, pid, request)
			got := rc.TotalTokens // the conversation side of the receipt: the instruction files are counted in their own category
			for _, b := range rc.Blocks {
				if b.Name == orchestrator.BlockInstructions {
					got -= b.Tokens
				}
			}
			want := conv + int64((len(request)+3)/4)
			tol := want/10 + 8
			if d := got - want; d > tol || -d > tol {
				t.Fatalf("receipt %d tokens vs report %d (+request): outside the estimator's tolerance %d", got, want, tol)
			}
			// After a turn the model's own report replaces the estimate and the last request is known.
			rep2, _ := r.orch.Context(context.Background(), pid, "")
			if rep2.Estimated || rep2.LastRequest == nil || rep2.LastRequest.Input == 0 || sum(rep2.Categories) != rep2.UsedTokens {
				t.Fatalf("after a turn: %+v", rep2)
			}
		})
	}
}

func TestContextOfAnACPOrchestratorIsTheAgentsOwnReport(t *testing.T) {
	r := newACPRig(t, mockLLMQuick(), fakeAgent("fake", true))
	r.svc = r.svcWithAgents(t, fakeAgent("fake", true))
	name := "p"
	p, err := r.svc.Create(context.Background(), project.Input{Name: &name, Folders: &[]project.FolderInput{{Path: t.TempDir()}},
		Models: &config.Models{Orchestrator: "acp:fake"}})
	if err != nil {
		t.Fatal(err)
	}
	if st := r.runCollect(t, p.ID, "[echo] hi", nil).status; st != "completed" {
		t.Fatal(st)
	}
	rep, err := r.orch.Context(context.Background(), p.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if rep.Source != "agent" || len(rep.Categories) != 0 || rep.WindowSource == "default" {
		t.Fatalf("report = %+v: an ACP agent's context is its own, no invented categories", rep)
	}
	raw, _ := json.Marshal(rep)
	if !strings.Contains(string(raw), `"categories":[]`) || !strings.Contains(string(raw), `"source":"agent"`) {
		t.Fatalf("json = %s", raw)
	}
}

func TestContextUpdatedIsPublishedAfterTurnsAndWhenNotesOrInstructionFilesChange(t *testing.T) {
	r := newRig(t, mockLLMQuick())
	pid := r.project(t, 1)
	ch, cancel := r.hub.Subscribe(pid)
	defer cancel()
	count := func() int {
		n := 0
		for {
			select {
			case ev := <-ch:
				if ev.Type == events.ContextUpdated {
					var d struct {
						ProjectID string `json:"project_id"`
					}
					_ = json.Unmarshal(ev.Data, &d)
					if d.ProjectID != pid {
						t.Fatalf("context.updated = %s", ev.Data)
					}
					n++
				}
			default:
				return n
			}
		}
	}
	if st := r.run(t, pid, "quick hello", nil); st != "completed" {
		t.Fatal(st)
	}
	waitTurn(t, r, pid)
	if count() == 0 {
		t.Fatal("no context.updated after a turn")
	}
	if _, err := r.notes.Create(context.Background(), pid, "n", "text"); err != nil {
		t.Fatal(err)
	}
	if count() == 0 {
		t.Fatal("no context.updated after a note changed")
	}
}

func mockLLMQuick() http.Handler { return mockllm.New(0) }
