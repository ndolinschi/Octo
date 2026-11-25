package orchestrator_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// sleepers lists the processes whose command line holds marker.
func sleepers(marker string) []string {
	var out []string
	procs, _ := filepath.Glob("/proc/[0-9]*/cmdline")
	for _, p := range procs {
		b, err := os.ReadFile(p)
		if err == nil && strings.Contains(strings.ReplaceAll(string(b), "\x00", " "), marker) {
			out = append(out, p)
		}
	}
	return out
}

// The owner's live re-test: Stop while a built-in sub-agent runs `bash` (here `sleep 41.37; echo …`) kept the
// turn running until the command ended, because only `bash` was killed and its `sleep` held the output pipes. A
// stop (the per-session cancel and the project-level alias) must end the turn within a couple of seconds, leave
// the sub-agent cancelled with its interrupted call closed, and leave no sleep behind.
func TestStopKillsASubAgentsRunningCommand(t *testing.T) {
	if _, err := os.Stat("/proc/self/cmdline"); err != nil {
		t.Skip("needs /proc to look for the left-over process")
	}
	for _, how := range []string{"session", "project"} {
		t.Run(how, func(t *testing.T) {
			r := newRig(t, mockllm.New(0))
			pid := r.project(t, 1)
			sid := r.defaultSession(t, pid)
			ch, cancel := r.hub.Subscribe(pid)
			defer cancel()
			marker := "41.37"
			if how == "project" {
				marker = "41.38"
			}
			r.post(t, pid, sid, "Go [bash:sleep "+marker+"; echo slept]")
			psWait(t, "the sub-agent's sleep", func() bool { return len(sleepers("sleep "+marker)) > 0 })
			time.Sleep(200 * time.Millisecond)
			start := time.Now()
			if how == "session" {
				if _, err := r.svc.StopSession(context.Background(), pid, sid); err != nil {
					t.Fatal(err)
				}
			} else if err := r.svc.Cancel(context.Background(), pid); err != nil {
				t.Fatal(err)
			}
			var fin map[string]any
			deadline := time.After(10 * time.Second)
			for fin == nil {
				select {
				case ev := <-ch:
					if ev.Type == events.TurnFinished {
						_ = json.Unmarshal(ev.Data, &fin)
					}
				case <-deadline:
					t.Fatal("the turn did not end after the stop")
				}
			}
			if took := time.Since(start); took > 2*time.Second || fin["status"] != "cancelled" {
				t.Fatalf("turn ended %v after the stop with %v", took, fin["status"])
			}
			psWait(t, "no sleep left", func() bool { return len(sleepers("sleep "+marker)) == 0 })
			for _, a := range r.agents(t, pid) {
				if a.ParentID == nil {
					continue
				}
				if a.Status != projectstore.StatusCancelled {
					t.Fatalf("sub-agent %s = %s", a.Title, a.Status)
				}
				msgs, _ := r.svc.Messages(context.Background(), pid, a.ID)
				open := map[string]bool{}
				for _, m := range msgs {
					for _, b := range m.Content {
						if b.Type == "tool_use" && b.ID != nil {
							open[*b.ID] = true
						}
						if b.Type == "tool_result" && b.ToolUseID != nil {
							delete(open, *b.ToolUseID)
						}
					}
				}
				if len(open) > 0 {
					t.Fatalf("sub-agent %s left calls without a result: %v", a.Title, open)
				}
			}
		})
	}
}
