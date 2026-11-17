package commands_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/projcfg"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

func TestStartAdhocForceStopAndRestart(t *testing.T) {
	f := newFixture(t, projcfg.Command{Name: "Server", Command: "echo ready; trap '' TERM; sleep 30"})
	ctx := context.Background()

	// StartAdhoc launches a custom shell command and reports a live OS PID.
	adhoc, err := f.svc.StartAdhoc(ctx, f.pid, "", "echo adhoc-hello", "")
	if err != nil {
		t.Fatalf("StartAdhoc: %v", err)
	}
	if adhoc.PID <= 0 {
		t.Fatalf("expected live PID > 0 on StartAdhoc, got %d", adhoc.PID)
	}
	if adhoc.Name != "echo adhoc-hello" {
		t.Fatalf("expected default name 'echo adhoc-hello', got %q", adhoc.Name)
	}
	out := f.wait(adhoc.ID)
	if out.status != projectstore.RunFinished || out.exit != 0 || !strings.Contains(out.stdout, "adhoc-hello") {
		t.Fatalf("unexpected adhoc outcome: %+v", out)
	}
	settled, err := f.svc.Get(ctx, f.pid, adhoc.ID)
	if err != nil {
		t.Fatalf("Get adhoc: %v", err)
	}
	if settled.PID != 0 {
		t.Fatalf("expected finished run PID to be 0, got %d", settled.PID)
	}

	// Restarting a finished ad-hoc run spawns a new run with the same command & cwd.
	restartedAdhoc, err := f.svc.Restart(ctx, f.pid, adhoc.ID)
	if err != nil {
		t.Fatalf("Restart finished adhoc: %v", err)
	}
	if restartedAdhoc.ID == adhoc.ID {
		t.Fatalf("expected new run ID on Restart")
	}
	out2 := f.wait(restartedAdhoc.ID)
	if out2.status != projectstore.RunFinished || !strings.Contains(out2.stdout, "adhoc-hello") {
		t.Fatalf("unexpected restarted adhoc outcome: %+v", out2)
	}

	// StopWith(force=true) sends SIGKILL immediately without waiting for StopGrace (300ms) even when TERM is ignored.
	srv, err := f.svc.Start(ctx, f.pid, "Server", "")
	if err != nil {
		t.Fatalf("Start Server: %v", err)
	}
	if srv.PID <= 0 {
		t.Fatalf("expected live PID > 0 on Server, got %d", srv.PID)
	}
	time.Sleep(80 * time.Millisecond)
	t0 := time.Now()
	stopped, err := f.svc.StopWith(ctx, f.pid, srv.ID, true)
	elapsed := time.Since(t0)
	if err != nil {
		t.Fatalf("StopWith(force): %v", err)
	}
	if stopped.Status != projectstore.RunStopped {
		t.Fatalf("expected status stopped, got %q", stopped.Status)
	}
	if elapsed >= 250*time.Millisecond {
		t.Fatalf("expected immediate SIGKILL under 250ms, took %v", elapsed)
	}
	_ = f.wait(srv.ID)

	// Restarting a running command stops the old process and starts a fresh one with a new PID.
	srv2, err := f.svc.Start(ctx, f.pid, "Server", "")
	if err != nil {
		t.Fatalf("Start Server 2: %v", err)
	}
	srv3, err := f.svc.Restart(ctx, f.pid, srv2.ID)
	if err != nil {
		t.Fatalf("Restart running Server: %v", err)
	}
	if srv3.ID == srv2.ID || srv3.Status != projectstore.RunRunning || srv3.PID <= 0 {
		t.Fatalf("unexpected restarted server: %+v", srv3)
	}
	prevRow, err := f.svc.Get(ctx, f.pid, srv2.ID)
	if err != nil {
		t.Fatalf("Get stopped previous server: %v", err)
	}
	if prevRow.Status != projectstore.RunStopped {
		t.Fatalf("expected previous server status stopped, got %q", prevRow.Status)
	}
	_, _ = f.svc.StopWith(ctx, f.pid, srv3.ID, true)
}
