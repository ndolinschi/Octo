package orchestrator_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/anthropicclient"
	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakeacp"
	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

func collectCompact(t *testing.T, r *rig, pid string) collected {
	t.Helper()
	ch, cancel := r.hub.Subscribe(pid)
	defer cancel()
	_, sent, err := r.orch.CompactViaAgent(context.Background(), pid)
	if err != nil || !sent {
		t.Fatalf("CompactViaAgent = sent:%v err:%v", sent, err)
	}
	var out collected
	timeout := time.After(30 * time.Second)
	for {
		select {
		case ev, ok := <-ch:
			if !ok {
				t.Fatal("event stream closed")
			}
			out.events = append(out.events, ev)
			if ev.Type == events.TurnFinished {
				out.status = out.of(events.TurnFinished)[0]["status"].(string)
				return out
			}
		case <-timeout:
			t.Fatal("timed out waiting for turn.finished")
		}
	}
}

func TestACPCompactionSuccessAndFailure(t *testing.T) {
	t.Run("opencode session_info_update compaction completes without AgentSilent", func(t *testing.T) {
		ag := fakeAgent("fake", true)
		ag.Launch.Env[fakeacp.EnvCommands] = "compact|Compact context"
		ag.Launch.Env[fakeacp.EnvCompact] = "opencode"
		r := newACPRig(t, mockllm.New(0), ag)
		pid := r.supervisedProject(t, t.TempDir(), "acp:fake")

		if got := r.runCollect(t, pid, "[echo] hi", nil); got.status != "completed" {
			t.Fatalf("warmup = %s", got.status)
		}
		got := collectCompact(t, r, pid)
		if got.status != "completed" {
			t.Fatalf("compact turn = %s, fin = %v", got.status, got.of(events.TurnFinished))
		}
		compEvents := got.of(events.AgentCompacted)
		if len(compEvents) != 1 || compEvents[0]["manual"] != true {
			t.Fatalf("agent.compacted = %v, want 1 manual compaction event", compEvents)
		}
		db, err := r.store.Get(context.Background(), pid)
		if err != nil {
			t.Fatal(err)
		}
		orch := r.agents(t, pid)[0]
		comp, ok, err := db.LatestCompaction(context.Background(), orch.ID)
		if err != nil || !ok || !comp.Manual {
			t.Fatalf("LatestCompaction = %+v ok=%v err=%v", comp, ok, err)
		}
	})

	t.Run("standard acp compaction stores summary", func(t *testing.T) {
		ag := fakeAgent("fake", true)
		ag.Launch.Env[fakeacp.EnvCommands] = "compact|Compact context"
		ag.Launch.Env[fakeacp.EnvCompact] = "acp"
		r := newACPRig(t, mockllm.New(0), ag)
		pid := r.supervisedProject(t, t.TempDir(), "acp:fake")

		if got := r.runCollect(t, pid, "[echo] hi", nil); got.status != "completed" {
			t.Fatalf("warmup = %s", got.status)
		}
		got := collectCompact(t, r, pid)
		if got.status != "completed" {
			t.Fatalf("compact turn = %s, fin = %v", got.status, got.of(events.TurnFinished))
		}
		db, err := r.store.Get(context.Background(), pid)
		if err != nil {
			t.Fatal(err)
		}
		orch := r.agents(t, pid)[0]
		comp, ok, err := db.LatestCompaction(context.Background(), orch.ID)
		if err != nil || !ok || comp.Summary != "Compressed summary." {
			t.Fatalf("LatestCompaction = %+v ok=%v err=%v", comp, ok, err)
		}
	})

	t.Run("failed compaction surfaces error and retry after restart works without duplicating /compact", func(t *testing.T) {
		dataDir := t.TempDir()
		store, err := projectstore.Open(dataDir)
		if err != nil {
			t.Fatal(err)
		}
		ag := fakeAgent("fake", true)
		ag.Launch.Env[fakeacp.EnvCommands] = "compact|Compact context"
		ag.Launch.Env[fakeacp.EnvCompact] = "fail"
		hub := events.NewHub()
		notes := project.NewNotes(store, hub)
		orchSvc := orchestrator.New(store, hub, notes, orchestrator.Options{
			Client: anthropicclient.New("k", "http://127.0.0.1:1", ""), MaxTurns: 10, Agents: []plugins.Agent{ag},
		})
		svc := project.NewService(store, hub, orchSvc, project.Defaults{Models: config.DefaultModels(), MaxDepth: 3})
		r := &rig{store: store, hub: hub, orch: orchSvc, svc: svc}
		pid := r.supervisedProject(t, t.TempDir(), "acp:fake")

		if got := r.runCollect(t, pid, "[echo] hi", nil); got.status != "completed" {
			t.Fatalf("warmup = %s", got.status)
		}
		got := collectCompact(t, r, pid)
		if got.status != "failed" {
			t.Fatalf("compact turn = %s, want failed", got.status)
		}
		fin := got.of(events.TurnFinished)[0]
		if errMsg, _ := fin["error"].(string); !strings.Contains(errMsg, "could not finish the request") {
			t.Errorf("error = %q, want agent_failed wording", errMsg)
		}
		if details, _ := fin["details"].(string); !strings.Contains(details, "Compaction ran out of context") {
			t.Errorf("details = %q, want compaction error detail", details)
		}
		if fin["action"] != "retry" {
			t.Errorf("action = %v, want retry", fin["action"])
		}

		// Simulate a harness restart (command list not yet re-advertised, mode switched to opencode).
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		_ = orchSvc.Shutdown(ctx)
		cancel()
		_ = store.Close()

		store2, err := projectstore.Open(dataDir)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = store2.Close() })
		ag2 := fakeAgent("fake", true)
		ag2.Launch.Env[fakeacp.EnvCommands] = "compact|Compact context"
		ag2.Launch.Env[fakeacp.EnvCompact] = "opencode"
		hub2 := events.NewHub()
		notes2 := project.NewNotes(store2, hub2)
		orchSvc2 := orchestrator.New(store2, hub2, notes2, orchestrator.Options{
			Client: anthropicclient.New("k", "http://127.0.0.1:1", ""), MaxTurns: 10, Agents: []plugins.Agent{ag2},
		})
		t.Cleanup(func() {
			c, cancel2 := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel2()
			_ = orchSvc2.Shutdown(c)
		})
		svc2 := project.NewService(store2, hub2, orchSvc2, project.Defaults{Models: config.DefaultModels(), MaxDepth: 3})
		r2 := &rig{store: store2, hub: hub2, orch: orchSvc2, svc: svc2}

		got2 := collectCompact(t, r2, pid)
		if got2.status != "completed" {
			t.Fatalf("retried compact turn = %s, fin = %v", got2.status, got2.of(events.TurnFinished))
		}
		root := r2.agents(t, pid)[0]
		msgs := r2.transcript(t, pid, root.ID)
		compactCount := 0
		for _, m := range msgs {
			if m.Role == "user" && m.Command == "compact" {
				compactCount++
			}
		}
		if compactCount != 1 {
			t.Fatalf("compact user messages = %d, want 1 (retried without duplicating)", compactCount)
		}
	})
}

func TestOpenCodeErrorThoughtOnlyAndStderrModes(t *testing.T) {
	const login = "Sign in with OpenCode first."
	for _, tc := range []struct {
		name        string
		ask         string
		wantMessage string
		wantHint    string
		wantAction  string
		wantDetails []string
	}{
		{
			// A bare 429 is a rate limit: the user is offered another model (this agent keeps one login).
			name:        "mid-turn agent_error",
			ask:         fakeacp.MarkerAgentError + " hi",
			wantMessage: "is being rate limited",
			wantHint:    "Retry in a moment, or pick another model.",
			wantAction:  "switch_account",
			wantDetails: []string{"APIError", "Upstream provider rate limit reached"},
		},
		{
			name:        "mid-turn auth agent_error",
			ask:         fakeacp.MarkerAgentAuthError + " hi",
			wantMessage: "is not logged in",
			wantHint:    "Log in to it in a terminal",
			wantAction:  "recheck_provider",
			wantDetails: []string{"ProviderAuthError", "Invalid API key", login},
		},
		{
			name:        "thought-only turn",
			ask:         fakeacp.MarkerThoughtOnly + " hi",
			wantMessage: "stopped before writing an answer",
			wantHint:    "Try sending your request again",
			wantAction:  "retry",
			wantDetails: []string{"streamed reasoning"},
		},
		{
			name:        "silent with stderr",
			ask:         fakeacp.MarkerSilentStderr + " hi",
			wantMessage: "answered with nothing",
			wantHint:    "may not be logged in",
			wantAction:  "recheck_provider",
			wantDetails: []string{login, "AI_APICallError"},
		},
	} {
		t.Run("orchestrator "+tc.name, func(t *testing.T) {
			ag := fakeAgent("fake", true)
			ag.Hint = login
			r := newACPRig(t, mockllm.New(0), ag)
			pid := r.supervisedProject(t, t.TempDir(), "acp:fake")
			got := r.runCollect(t, pid, tc.ask, nil)
			if got.status != "failed" {
				t.Fatalf("turn = %s, want failed", got.status)
			}
			fin := got.of(events.TurnFinished)[0]
			msg, _ := fin["error"].(string)
			hint, _ := fin["hint"].(string)
			action, _ := fin["action"].(string)
			details, _ := fin["details"].(string)
			if !strings.Contains(msg, tc.wantMessage) || !strings.Contains(hint, tc.wantHint) || action != tc.wantAction {
				t.Errorf("got msg=%q hint=%q action=%q", msg, hint, action)
			}
			for _, want := range tc.wantDetails {
				if !strings.Contains(details, want) {
					t.Errorf("details = %q, missing %q", details, want)
				}
			}
		})

		t.Run("sub-agent "+tc.name, func(t *testing.T) {
			ag := fakeAgent("fake", true)
			ag.Hint = login
			r := newACPRig(t, mockllm.New(0), ag)
			pid := r.projectAt(t, t.TempDir())
			r.runCollect(t, pid, "[acp] "+tc.ask, nil)
			child := r.acpChild(t, pid)
			if child.Status != projectstore.StatusFailed || child.Error == nil {
				t.Fatalf("sub-agent = %s %v, want failed", child.Status, child.Error)
			}
			if !strings.Contains(*child.Error, tc.wantMessage) {
				t.Errorf("sub-agent error = %q, want %q", *child.Error, tc.wantMessage)
			}
			if child.ErrorHint == nil || !strings.Contains(*child.ErrorHint, tc.wantHint) {
				t.Errorf("sub-agent error_hint = %v, want %q", child.ErrorHint, tc.wantHint)
			}
		})
	}
}

func TestACPMessageAbortedErrorPreservesCancelledStatus(t *testing.T) {
	r := newACPRig(t, mockllm.New(0), fakeAgent("fake", true))
	pid := r.supervisedProject(t, t.TempDir(), "acp:fake")
	got := r.runCollect(t, pid, fakeacp.MarkerAgentAbortError+" hi", func(ch <-chan events.Event) {
		deadline := time.After(15 * time.Second)
		for {
			select {
			case ev := <-ch:
				if ev.Type == events.AgentUpdated {
					time.Sleep(150 * time.Millisecond)
					r.orch.Cancel(pid)
					return
				}
			case <-deadline:
				t.Fatal("agent never entered running state")
			}
		}
	})
	if got.status != "cancelled" {
		t.Fatalf("turn = %s, want cancelled (events=%v)", got.status, got.of(events.TurnFinished))
	}
}
