package lsp_test

import (
	"context"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/lsp"
)

func TestListProjectAndRestart(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("sh")
	}
	mgr := lsp.NewManager(lsp.Options{IdleTimeout: 10 * time.Second})
	t.Cleanup(func() { _ = mgr.Shutdown(context.Background()) })

	dir := t.TempDir()
	s1, err := mgr.Start(context.Background(), "p1", lsp.Spec{
		Name:    "tsserver",
		Command: "sh",
		Args:    []string{"-c", "echo boot-stderr >&2; sleep 30"},
		Dir:     dir,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	oldPID := s1.PID()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		list := mgr.ListProject("p1")
		if len(list) == 1 && strings.Contains(list[0].StderrTail, "boot-stderr") {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	list := mgr.ListProject("p1")
	if len(list) != 1 {
		t.Fatalf("expected 1 session in p1, got %d", len(list))
	}
	if list[0].PID != oldPID || list[0].Spec.Name != "tsserver" || !strings.Contains(list[0].StderrTail, "boot-stderr") {
		t.Fatalf("unexpected session info: %+v", list[0])
	}
	if other := mgr.ListProject("p2"); len(other) != 0 {
		t.Fatalf("expected 0 sessions in p2, got %d", len(other))
	}

	s2, err := mgr.Restart(context.Background(), "p1", s1.ID)
	if err != nil {
		t.Fatalf("Restart: %v", err)
	}
	if s2.ID == s1.ID || s2.PID() <= 0 || s2.PID() == oldPID {
		t.Fatalf("expected fresh session and PID after Restart: old=(%s,%d) new=(%s,%d)", s1.ID, oldPID, s2.ID, s2.PID())
	}
	if !s1.Finished() {
		t.Fatalf("expected old session to be finished after Restart")
	}
}
