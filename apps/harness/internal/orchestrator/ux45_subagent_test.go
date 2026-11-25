package orchestrator_test

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/fakeacp"
	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
)

// UX-45: an ACP sub-agent spawned by the built-in orchestrator starts in its own
// self-approving mode (the agy profile, like Claude Code, starts in "auto"). A
// supervised project must switch it to the asking mode with session/set_mode
// before the task is prompted, under accept_edits too (the harness approves the
// edits itself); a full-access
// project keeps the agent's own mode (no regression).
func TestACPSubAgentModeFollowsTheProjectsAccess(t *testing.T) {
	for _, c := range []struct{ access, want string }{
		{"supervised", "mode=default"},
		{"accept_edits", "mode=default"},
		{"full", "mode=auto"},
	} {
		t.Run(c.access, func(t *testing.T) {
			ag := agyAgent(signedIn(t))
			reqLog := t.TempDir() + "/requests.log"
			ag.Launch.Env[fakeacp.EnvRequestLog] = reqLog
			r := newACPRig(t, mockllm.New(0), ag)
			r.svc = r.svcWithAgents(t, ag)
			name, dir, access := "p", t.TempDir(), c.access
			p, err := r.svc.Create(context.Background(), project.Input{Name: &name, Folders: &[]project.FolderInput{{Path: dir}}, Access: &access})
			if err != nil {
				t.Fatal(err)
			}
			if st := r.runCollect(t, p.ID, "[acp] [mode] which mode?", nil).status; st != "completed" {
				t.Fatalf("turn = %s", st)
			}
			child := r.acpChild(t, p.ID)
			got := "<nil>"
			if child.Result != nil {
				got = *child.Result
			}
			if !strings.Contains(got, c.want) {
				t.Fatalf("%s: sub-agent reported %q, want %q", c.access, got, c.want)
			}
			b, _ := os.ReadFile(reqLog)
			log := string(b)
			setMode := strings.Index(log, "session/set_mode")
			prompt := strings.Index(log, "session/prompt")
			if c.access == "full" {
				if setMode >= 0 {
					t.Fatalf("full access: the sub-agent's mode was forced:\n%s", log)
				}
				return
			}
			if setMode < 0 || prompt < 0 || setMode > prompt {
				t.Fatalf("%s: want session/set_mode before session/prompt, request log:\n%s", c.access, log)
			}
		})
	}
}
