package orchestrator_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakeacp"
	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// NEW-10: an ACP orchestrator whose process dies after working on the request for a while without a word is not
// restarted with the request sent again (it was working, not gone before the prompt): the request reaches the
// agent once and the turn fails as a crash in the middle of the request, not "stopped while starting".
func TestAgentDeathWhileWorkingIsNotARestart(t *testing.T) {
	r := newACPRig(t, mockllm.New(0), fakeAgent("fake", true))
	dir := t.TempDir()
	pid := r.supervisedProject(t, dir, "acp:fake")
	got := r.runCollect(t, pid, "[die-silent] run the suite", nil)
	if got.status != "failed" {
		t.Fatalf("turn = %s", got.status)
	}
	fin := got.of(events.TurnFinished)[0]
	if msg, _ := fin["error"].(string); !strings.Contains(msg, "stopped in the middle of the request") {
		t.Fatalf("error = %q", msg)
	}
	runs, err := os.ReadFile(filepath.Join(dir, fakeacp.DieSilentLog))
	if err != nil {
		t.Fatal(err)
	}
	if n := strings.Count(string(runs), "[die-silent] run the suite"); n != 1 {
		t.Fatalf("the request reached an agent %d times, want once:\n%s", n, runs)
	}
}

// NEW-10: when a turn ends (here: the agent killed during a command), the last session.updated of the session comes
// after turn.finished and no longer says working, so a client that shows Stop from the session's state drops it at once.
func TestSessionStateAfterTheTurnSaysItEnded(t *testing.T) {
	r := newACPRig(t, mockllm.New(0), fakeAgent("fake", true))
	pid := r.supervisedProject(t, t.TempDir(), "acp:fake")
	ch, cancel := r.hub.Subscribe(pid)
	defer cancel()
	got := r.runCollect(t, pid, "[die-in-command] go", nil)
	if got.status != "failed" {
		t.Fatalf("turn = %s", got.status)
	}
	if msg, _ := got.of(events.TurnFinished)[0]["error"].(string); !strings.Contains(msg, "stopped in the middle of the request") {
		t.Fatalf("error = %q", msg)
	}
	// The events after turn.finished: drain what the turn's goroutine publishes once it has finished.
	var after []string
	seenFinish := false
	waitUntil(t, "a session.updated after turn.finished", func() bool {
		for {
			select {
			case ev := <-ch:
				if ev.Type == events.TurnFinished {
					seenFinish = true
				}
				if seenFinish && ev.Type == events.SessionUpdated {
					var p struct {
						Session struct {
							State string `json:"state"`
						} `json:"session"`
					}
					if err := json.Unmarshal(ev.Data, &p); err != nil {
						t.Fatal(err)
					}
					after = append(after, p.Session.State)
				}
			default:
				return len(after) > 0
			}
		}
	})
	if last := after[len(after)-1]; last == projectstore.SessionWorking || last == projectstore.SessionWaiting {
		t.Fatalf("session states after turn.finished = %v, want the turn's end", after)
	}
}

// NEW-10 (D5): an ACP orchestrator killed as soon as the request reached it is
// started again once; when that restart fails too, the turn reads as the agent
// stopping in the middle of the request, not "stopped while starting".
func TestAgentKilledAtOnceWithAFailedRestartIsACrash(t *testing.T) {
	ag := fakeAgent("fake", true)
	dir := t.TempDir()
	marker := filepath.Join(t.TempDir(), "launched")
	wrapper := filepath.Join(t.TempDir(), "agent.sh")
	// The first launch runs the fake agent; every later launch exits at once.
	script := "#!/bin/sh\nif [ -e " + marker + " ]; then exit 1; fi\n: > " + marker + "\nexec \"" + os.Args[0] + "\" \"$@\"\n"
	if err := os.WriteFile(wrapper, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	ag.Launch.Command = wrapper
	r := newACPRig(t, mockllm.New(0), ag)
	pid := r.supervisedProject(t, dir, "acp:fake")
	if st := r.runCollect(t, pid, "[live] go", nil).status; st != "completed" {
		t.Fatalf("first turn = %s", st)
	}
	got := r.runCollect(t, pid, "[die-at-once] run the suite", nil)
	if got.status != "failed" {
		t.Fatalf("turn = %s", got.status)
	}
	msg, _ := got.of(events.TurnFinished)[0]["error"].(string)
	if strings.Contains(msg, "while starting") || !strings.Contains(msg, "stopped in the middle of the request") {
		t.Fatalf("error = %q", msg)
	}
}
