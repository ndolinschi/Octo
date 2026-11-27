package orchestrator_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakeacp"
	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
)

// Switching a project from an agent's default account to another account
// ("acp:fake" then "acp:fake@two") never resumes the old account's session:
// the other account's process starts a new one.
func TestSwitchingAccountStartsANewSession(t *testing.T) {
	logs := t.TempDir()
	def := fakeAgent("fake", true)
	two := fakeAgent("fake@two", true)
	two.BaseID, def.BaseID = "fake", "fake"
	for _, a := range []struct {
		env map[string]string
		log string
	}{{def.Env, "default.log"}, {two.Env, "two.log"}} {
		a.env[fakeacp.EnvLoadSession] = "1"
		a.env[fakeacp.EnvUniqueSessions] = "1"
		a.env[fakeacp.EnvRequestLog] = filepath.Join(logs, a.log)
	}

	r := newACPRig(t, mockllm.New(0), def, two)
	pid := r.projectAt(t, t.TempDir())
	svc := r.svcWithAgents(t, def, two)
	use := func(model string) {
		t.Helper()
		if _, err := svc.Update(context.Background(), pid, project.Input{Models: &config.Models{Orchestrator: model}}); err != nil {
			t.Fatal(err)
		}
	}
	use("acp:fake")
	if got := r.runCollect(t, pid, "one", nil); got.status != "completed" {
		t.Fatalf("first turn = %s", got.status)
	}
	for r.orch.Running(pid) {
		time.Sleep(time.Millisecond)
	}
	use("acp:fake@two")
	if got := r.runCollect(t, pid, "two", nil); got.status != "completed" {
		t.Fatalf("second turn = %s", got.status)
	}
	read := func(name string) string {
		b, err := os.ReadFile(filepath.Join(logs, name))
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	if l := read("two.log"); !strings.Contains(l, "session/new") || strings.Contains(l, "session/load") || !strings.Contains(l, "session/prompt") {
		t.Fatalf("the other account's requests:\n%s", l)
	}
	if l := read("default.log"); strings.Count(l, "session/prompt") != 1 {
		t.Fatalf("the default account ran the second turn:\n%s", l)
	}
}
