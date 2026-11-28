package orchestrator_test

import (
	"context"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/memory"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
)

func TestBuiltInRetryAfterMidTurnFailureCarriesContinuationContext(t *testing.T) {
	for _, mode := range []string{memory.ContextFull, memory.ContextWindow} {
		t.Run(mode, func(t *testing.T) {
			var calls atomic.Int32
			rc := &modelLog{}
			r := newRig(t, fakeLLM(func(w http.ResponseWriter, _ *http.Request, req fakeReq) {
				switch calls.Add(1) {
				case 1:
					// Turn 1 iteration 1: produce verbose partial progress (head + tail) and call list_dir so the turn continues.
					longProgress := "Brainstorming started: React + Vite + Tailwind v4.\n" +
						strings.Repeat("Intermediate build output line.\n", 200) +
						"Task 3 committed. Now the visual check with a real browser."
					respond(w, "tool_use",
						textBlock(longProgress),
						toolUse("call_1", "list_dir", `{"path":"."}`),
					)
				case 2:
					// Turn 1 iteration 2: fail mid-turn after partial work was already stored (400 is not retried by the SDK).
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusBadRequest)
					_, _ = w.Write([]byte(`{"type":"error","error":{"type":"invalid_request_error","message":"upstream dropped mid-turn"}}`))
				default:
					rc.answer(w, req)
				}
			}))
			pid := r.project(t, 1)
			if mode == memory.ContextWindow {
				r.setMemory(t, pid, memory.Settings{Context: memory.ContextWindow, RecentExchanges: 4})
			}

			const ask = "I want to create a new project based on react"
			if st := r.run(t, pid, ask, nil); st != "failed" {
				t.Fatalf("first turn = %s, want failed", st)
			}
			// Clicking Retry re-sends the exact original request.
			if st := r.run(t, pid, ask, nil); st != "completed" {
				t.Fatalf("retry turn = %s, want completed", st)
			}
			got := rc.last(t)
			lastRole, lastText := wireText(t, got[len(got)-1])
			if lastRole != "user" {
				t.Fatalf("last role = %s, want user", lastRole)
			}
			for _, want := range []string{"failed before finishing after making partial progress", "do not start over", ask} {
				if !strings.Contains(lastText, want) {
					t.Errorf("retried user message missing %q:\n%s", want, lastText)
				}
			}
			if mode == memory.ContextWindow {
				// Window mode middle-clipping must keep both the opening design and where Turn 1 stopped.
				var combined strings.Builder
				for _, raw := range got {
					_, txt := wireText(t, raw)
					combined.WriteString(txt)
					combined.WriteByte('\n')
				}
				all := combined.String()
				for _, want := range []string{
					"Brainstorming started: React + Vite + Tailwind v4.",
					"Task 3 committed. Now the visual check with a real browser.",
					"ended before finishing (failed mid-turn)",
				} {
					if !strings.Contains(all, want) {
						t.Errorf("window context missing %q:\n%s", want, all)
					}
				}
			}

			// A later turn after the retry succeeds must NOT repeat the continuation note.
			if st := r.run(t, pid, "now add tests", nil); st != "completed" {
				t.Fatalf("third turn = %s, want completed", st)
			}
			got3 := rc.last(t)
			_, text3 := wireText(t, got3[len(got3)-1])
			if strings.Contains(text3, "do not start over") {
				t.Errorf("subsequent turn must not repeat retry continuation note:\n%s", text3)
			}
		})
	}
}

func TestBuiltInLoadHistoryIgnoresEmptyCompactionSummary(t *testing.T) {
	rc := &modelLog{}
	r := newRig(t, rc.handler())
	pid := r.project(t, 1)

	if st := r.run(t, pid, "remember the word tangerine", nil); st != "completed" {
		t.Fatalf("first turn = %s", st)
	}
	db, err := r.store.Get(context.Background(), pid)
	if err != nil {
		t.Fatal(err)
	}
	orch, err := db.Orchestrator(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// OpenCode compaction records a manual compaction row with an empty summary.
	if _, err := db.AddManualCompaction(context.Background(), orch.ID, "", 0); err != nil {
		t.Fatal(err)
	}
	if st := r.run(t, pid, "what word did I say?", nil); st != "completed" {
		t.Fatalf("second turn = %s", st)
	}
	var found bool
	for _, raw := range rc.last(t) {
		_, txt := wireText(t, raw)
		if strings.Contains(txt, "remember the word tangerine") {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("empty compaction summary hid earlier conversation: %s", rc.last(t))
	}
}

func TestACPFreshSessionAfterMidTurnCrashMarksPartialFailure(t *testing.T) {
	r := newACPRig(t, mockllmStub(), fakeAgent("fake", true))
	name := "p"
	p, err := r.svcWithAgents(t, fakeAgent("fake", true)).Create(context.Background(), project.Input{
		Name: &name, Folders: &[]project.FolderInput{{Path: t.TempDir()}}, Models: &config.Models{Orchestrator: "acp:fake"},
	})
	if err != nil {
		t.Fatal(err)
	}
	// [crash] announces a tool call (partial assistant progress) before dying.
	if st := r.run(t, p.ID, "[crash] build the react starter", nil); st != "failed" {
		t.Fatalf("first turn = %s, want failed", st)
	}
	// Next turn opens a fresh session (no loadSession) with a recap.
	if st := r.run(t, p.ID, "[echo] continue from where you stopped", nil); st != "completed" {
		t.Fatalf("second turn = %s, want completed", st)
	}
	_, msgs := orchMessages(t, r, p.ID)
	echo := messageTextOf(msgs[len(msgs)-1])
	for _, want := range []string{
		"Earlier in this conversation",
		"user: [crash] build the react starter",
		"previous turn ended before finishing (failed mid-turn)",
		"[echo] continue from where you stopped",
	} {
		if !strings.Contains(echo, want) {
			t.Errorf("fresh session prompt missing %q:\n%s", want, echo)
		}
	}
}
