package orchestrator_test

import (
	"context"
	"regexp"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
)

func TestRewindOfAnACPOrchestratorStartsANewSessionWithTheRecap(t *testing.T) {
	r := newACPRig(t, (&modeLLM{}).handler(), fakeAgent("fake", true))
	r.svc = r.svcWithAgents(t, fakeAgent("fake", true))
	name := "p"
	p, err := r.svc.Create(context.Background(), project.Input{Name: &name, Folders: &[]project.FolderInput{{Path: t.TempDir()}},
		Models: &config.Models{Orchestrator: "acp:fake"}})
	if err != nil {
		t.Fatal(err)
	}
	pid := p.ID
	pidOf := regexp.MustCompile(`pid=(\d+)`)
	run := func(text string) string {
		if st := r.runCollect(t, pid, text, nil).status; st != "completed" {
			t.Fatalf("%s: %s", text, st)
		}
		waitTurn(t, r, pid)
		return r.lastOrchestratorText(t, pid)
	}
	first := run("[echo] first request")
	run("[echo] second request")
	db, _ := r.store.Get(context.Background(), pid)
	orch, _ := db.Orchestrator(context.Background())
	var secondID int64
	for _, m := range r.transcript(t, pid, orch.ID) {
		if m.Role == "user" && len(m.Content) > 0 && m.Content[0].Text != nil && strings.Contains(*m.Content[0].Text, "second request") {
			secondID = m.ID
		}
	}
	rep, err := r.svc.Rewind(context.Background(), pid, secondID, false)
	if err != nil || !rep.ACPSessionReset || rep.RequestText != "[echo] second request" {
		t.Fatalf("rewind = %+v %v", rep, err)
	}
	if _, ok, _ := db.ACPSession(context.Background(), orch.ID); ok {
		t.Fatal("the stored ACP session survived the rewind")
	}
	third := run("[echo] third request")
	if pidOf.FindString(first) == pidOf.FindString(third) {
		t.Fatalf("the agent process was not restarted: %q / %q", first, third)
	}
	if !strings.Contains(third, "loaded=false") || !strings.Contains(third, "first request") || strings.Contains(third, "second request") {
		t.Fatalf("the new session's prompt must recap what is left and nothing of the cut turn: %q", third)
	}
}
