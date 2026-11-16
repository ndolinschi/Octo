package orchestrator_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakeacp"
	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
)

// agyAgent is the built-in antigravity entry pointed at the scripted agent's
// agy profile; loginFile is its saved sign-in ("" or a missing file: signed out).
func agyAgent(loginFile string) plugins.Agent {
	a := fakeAgent("antigravity", true)
	a.Label = "Antigravity"
	a.Args = []string{"acp"}
	a.Launch.Env[fakeacp.EnvProfile] = fakeacp.ProfileAgy
	a.Launch.Env[fakeacp.EnvUniqueSessions] = "1"
	if loginFile != "" {
		a.Launch.Env[fakeacp.EnvLoginFile] = loginFile
	}
	a.MCPTransport = plugins.MCPTransportStdio
	a.AuthMethods = []plugins.AuthMethodRef{{ID: "gemini-api-key", RequiresEnv: "GEMINI_API_KEY"}}
	a.AuthSkip = []string{"oauth-personal", "oauth-business", "agent-platform", "terminal-login"}
	a.LoginCommand = "agy acp --login"
	a.Hint = "Sign in once in a terminal: run `agy`, or `agy acp --login`."
	return a
}

func signedIn(t *testing.T) string {
	t.Helper()
	f := filepath.Join(t.TempDir(), "agy-login")
	if err := os.WriteFile(f, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	return f
}

func (r *rig) agyProject(t *testing.T, ag plugins.Agent, access string) (pid, dir string) {
	t.Helper()
	r.svc = r.svcWithAgents(t, ag)
	name, dir := "p", t.TempDir()
	p, err := r.svc.Create(context.Background(), project.Input{Name: &name, Folders: &[]project.FolderInput{{Path: dir}},
		Access: &access, Models: &config.Models{Orchestrator: "acp:antigravity"}})
	if err != nil {
		t.Fatal(err)
	}
	return p.ID, dir
}

// agy starts its sessions in auto (it approves its own workspace edits). A
// supervised project switches the session to agy's asking mode, default, so
// every change comes to Octo as a permission request; a full-access project
// keeps agy's own mode. Plan maps to agy's plan; agy has no ask mode, so an ask
// turn keeps the mode and the harness denies writes itself.
func TestAgyModesFollowTheProjectsAccess(t *testing.T) {
	for _, c := range []struct {
		access string
		modes  map[string]string // Octo mode -> agy mode reported
	}{
		{"supervised", map[string]string{"agent": "mode=default", "plan": "mode=plan"}},
		{"accept_edits", map[string]string{"agent": "mode=accept-edits", "plan": "mode=plan"}},
		{"full", map[string]string{"agent": "mode=auto", "plan": "mode=plan"}},
	} {
		t.Run(c.access, func(t *testing.T) {
			ag := agyAgent(signedIn(t))
			r := newACPRig(t, mockllm.New(0), ag)
			pid, _ := r.agyProject(t, ag, c.access)
			for _, mode := range []string{"agent", "plan", "agent"} {
				if st := r.runWith(t, pid, "[mode] which?", orchestrator.StartOpts{Mode: mode}); st != "completed" {
					t.Fatalf("%s: turn = %s", mode, st)
				}
				if got := r.lastOrchestratorText(t, pid); !strings.Contains(got, c.modes[mode]) {
					t.Fatalf("%s/%s: agy said %q, want %q", c.access, mode, got, c.modes[mode])
				}
			}
		})
	}
}

// Signed out: the first request fails with "Antigravity is not logged in.",
// the copyable `agy acp --login` and a "Check again" button, without the
// harness ever starting a browser sign-in.
func TestAgySignedOutIsNotLoggedIn(t *testing.T) {
	ag := agyAgent(filepath.Join(t.TempDir(), "absent"))
	log := filepath.Join(t.TempDir(), "auth.log")
	ag.Launch.Env[fakeacp.EnvAuthLog] = log
	r := newACPRig(t, mockllm.New(0), ag)
	pid, _ := r.agyProject(t, ag, "full")
	got := r.runCollect(t, pid, "hello", nil)
	fin := got.of(events.TurnFinished)[0]
	if got.status != "failed" || fin["error"] != "Antigravity is not logged in." || fin["command"] != "agy acp --login" ||
		fin["action"] != "recheck_provider" {
		t.Fatalf("turn.finished = %v", fin)
	}
	if b, _ := os.ReadFile(log); len(b) != 0 {
		t.Fatalf("authenticate was called: %q", b)
	}
}

// Stop while agy waits for an approval in a supervised project: the card is
// withdrawn, the turn ends cancelled within a second and agy keeps running, so
// the next request is answered by the same process.
func TestAgyStopDuringApprovalKeepsTheAgent(t *testing.T) {
	ag := agyAgent(signedIn(t))
	r := newACPRig(t, mockllm.New(0), ag)
	pid, dir := r.agyProject(t, ag, "supervised")
	if st := r.runWith(t, pid, "[mode] warm up", orchestrator.StartOpts{}); st != "completed" {
		t.Fatalf("warm-up turn = %s", st)
	}
	var stoppedAt time.Time
	got := r.runCollect(t, pid, "[perm] run the tests", func(ch <-chan events.Event) {
		for ev := range ch {
			if ev.Type != events.AgentActivity {
				continue
			}
			var a struct{ Kind string }
			_ = json.Unmarshal(ev.Data, &a)
			if a.Kind == "waiting_approval" {
				stoppedAt = time.Now()
				r.orch.Cancel(pid)
				return
			}
		}
	})
	if got.status != "cancelled" {
		t.Fatalf("turn = %s", got.status)
	}
	if d := time.Since(stoppedAt); d > 2*time.Second {
		t.Fatalf("stop took %s (the agent was killed after the cancel grace)", d)
	}
	if _, err := os.Stat(filepath.Join(dir, fakeacp.PermFile)); err == nil {
		t.Fatal("the command ran although the turn was stopped")
	}
	if st := r.runWith(t, pid, "[mode] still there?", orchestrator.StartOpts{}); st != "completed" {
		t.Fatalf("next turn = %s", st)
	}
}
