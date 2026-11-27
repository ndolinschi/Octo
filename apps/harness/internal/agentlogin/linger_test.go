package agentlogin_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/agentlogin"
	"github.com/ndolinschi/Octo/apps/harness/internal/terminal"
)

// A finished login whose event stream never came (or went away) is closed and
// unregistered Linger after its last check.
func TestAFinishedLoginIsClosedAfterItsLinger(t *testing.T) {
	f := newFixture(t, `true`, agentlogin.Options{PollEvery: time.Hour, Linger: 100 * time.Millisecond})
	l, err := f.svc.Start(context.Background(), "cc@work", agentlogin.Request{Method: "script"})
	if err != nil {
		t.Fatal(err)
	}
	wantDone(t, l)
	if _, err := f.svc.Get("cc@work", l.ID); err != nil {
		t.Fatalf("a just-finished login is gone at once: %v", err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		_, errTerm := f.mgr.Get(agentlogin.Project, l.ID)
		_, errLogin := f.svc.Get("cc@work", l.ID)
		if errors.Is(errTerm, terminal.ErrNotFound) && errors.Is(errLogin, agentlogin.ErrNotFound) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("finished login still registered: terminal %v, login %v", errTerm, errLogin)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// Replacing an agent's login frees its place first, so it works at the
// per-project session limit.
func TestReplacingALoginWorksAtTheSessionLimit(t *testing.T) {
	f := newFixtureWith(t, `sleep 30`, agentlogin.Options{PollEvery: time.Hour}, terminal.Options{MaxPerProject: 1})
	first, err := f.svc.Start(context.Background(), "cc@work", agentlogin.Request{Method: "script"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Start(context.Background(), "cc", agentlogin.Request{Method: "script"}); !errors.Is(err, terminal.ErrTooManySessions) {
		t.Fatalf("another agent's login at the limit: %v", err)
	}
	second, err := f.svc.Start(context.Background(), "cc@work", agentlogin.Request{Method: "script"})
	if err != nil {
		t.Fatalf("replace at the limit: %v", err)
	}
	if !first.Session().Finished() || second.Session().Finished() {
		t.Fatal("the old login runs or the new one does not")
	}
}
