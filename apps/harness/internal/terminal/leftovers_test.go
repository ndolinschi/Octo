//go:build linux || darwin

package terminal

import (
	"context"
	"os/exec"
	"regexp"
	"strconv"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/proctree"
)

func running(pid int) bool { _, err := proctree.StartTime(pid); return err == nil }

// startJobs opens an interactive bash terminal and starts two background jobs in it (each in a process group of its
// own, as job control does); it returns their pids.
func startJobs(t *testing.T, mgr *Manager) (*Session, []int) {
	t.Helper()
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("no bash")
	}
	sess, err := mgr.Start(context.Background(), "prj_1", Spec{Command: bash, Args: []string{"--norc", "-i"}, Dir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	ch, release, err := sess.Subscribe()
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if err := sess.WriteInput(context.Background(), []byte("sleep 777 & echo PID=$!; nohup sleep 778 >/dev/null 2>&1 & echo PID=$!; echo J\"\"OBS\n")); err != nil {
		t.Fatal(err)
	}
	out := readUntil(t, ch, "JOBS", 5*time.Second)
	var pids []int
	for _, m := range regexp.MustCompile(`PID=(\d+)`).FindAllStringSubmatch(out, -1) {
		n, _ := strconv.Atoi(m[1])
		pids = append(pids, n)
	}
	if len(pids) != 2 {
		t.Fatalf("pids %v in %q", pids, out)
	}
	for _, p := range pids {
		if !running(p) {
			t.Fatalf("job %d did not start", p)
		}
	}
	return sess, pids
}

func waitGone(t *testing.T, pids []int, what string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for _, p := range pids {
		for running(p) && time.Now().Before(deadline) {
			time.Sleep(20 * time.Millisecond)
		}
		if running(p) {
			t.Fatalf("background job %d outlived %s", p, what)
		}
	}
}

// Closing a terminal (DELETE …/terminals/{tid}) stops the jobs started with & in it, nohup included.
func TestCloseStopsBackgroundJobs(t *testing.T) {
	mgr := NewManager(Options{})
	defer func() { _ = mgr.Shutdown(context.Background()) }()
	sess, pids := startJobs(t, mgr)
	sess.Close("test")
	waitGone(t, pids, "closing its terminal")
}

// Shutting the harness down (SIGTERM) stops them too, and the ledger is empty afterwards.
func TestShutdownStopsBackgroundJobs(t *testing.T) {
	dir := t.TempDir()
	mgr := NewManager(Options{Children: proctree.OpenLedger(dir)})
	_, pids := startJobs(t, mgr)
	if err := mgr.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitGone(t, pids, "the harness shutting down")
	if got := proctree.OpenLedger(dir).Reap(time.Second); len(got) != 0 {
		t.Fatalf("ledger still lists %v", got)
	}
}
