//go:build unix

package proctree

import (
	"bufio"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// startSession runs bash as a session leader with job control on (as an
// interactive terminal shell has), starting background jobs in process groups of
// their own and one that leaves the session with setsid; it returns the
// leader's pid and the jobs' pids.
func startSession(t *testing.T) (*exec.Cmd, []int) {
	t.Helper()
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("no bash")
	}
	cmd := exec.Command("bash", "-c", `set -m; sleep 777 & echo $!; (sleep 778 & echo $!; wait) & if command -v setsid >/dev/null; then setsid sleep 779 & echo $!; fi; echo done; wait`)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	var pids []int
	sc := bufio.NewScanner(out)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "done" {
			break
		}
		if n, err := strconv.Atoi(line); err == nil {
			pids = append(pids, n)
		}
	}
	t.Cleanup(func() {
		for _, p := range pids {
			_ = syscall.Kill(p, syscall.SIGKILL)
		}
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})
	return cmd, pids
}

func alive(pid int) bool { _, err := StartTime(pid); return err == nil }

func TestKillSessionStopsBackgroundJobsAndDescendants(t *testing.T) {
	cmd, jobs := startSession(t)
	if len(jobs) < 2 {
		t.Fatalf("jobs = %v", jobs)
	}
	for _, p := range jobs {
		if !alive(p) {
			t.Fatalf("job %d not running", p)
		}
	}
	go func() { _ = cmd.Wait() }()
	KillSession(cmd.Process.Pid, time.Second)
	deadline := time.Now().Add(3 * time.Second)
	for _, p := range jobs {
		for alive(p) && time.Now().Before(deadline) {
			time.Sleep(20 * time.Millisecond)
		}
		if alive(p) {
			t.Fatalf("job %d survived KillSession", p)
		}
	}
}

// The leader's shell ended first (the terminal was closed): its jobs, re-parented, are still found by session id.
func TestKillSessionAfterLeaderExited(t *testing.T) {
	cmd, jobs := startSession(t)
	_ = cmd.Process.Signal(syscall.SIGKILL)
	_ = cmd.Wait()
	if !alive(jobs[0]) {
		t.Fatal("job ended with the shell")
	}
	KillSession(cmd.Process.Pid, time.Second)
	time.Sleep(100 * time.Millisecond)
	if alive(jobs[0]) {
		t.Fatalf("job %d survived", jobs[0])
	}
}

// A ledger written by a crashed instance: the next one stops the recorded session, and leaves a pid whose start time
// differs alone.
func TestLedgerReapsOnlyMatchingLeftovers(t *testing.T) {
	dir := t.TempDir()
	cmd, jobs := startSession(t)
	go func() { _ = cmd.Wait() }()
	old := OpenLedger(dir)
	old.Add(cmd.Process.Pid, "terminal", "bash")
	other := exec.Command("sleep", "60")
	other.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := other.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = other.Process.Kill(); _ = other.Wait() })
	old.mu.Lock()
	old.m[other.Process.Pid] = Entry{PID: other.Process.Pid, Start: "1", Kind: "process"}
	old.saveLocked()
	old.mu.Unlock()

	stopped := OpenLedger(dir).Reap(time.Second)
	if len(stopped) != 1 || stopped[0].PID != cmd.Process.Pid {
		t.Fatalf("stopped %+v", stopped)
	}
	time.Sleep(100 * time.Millisecond)
	if alive(jobs[0]) {
		t.Fatal("a leftover job survived the reap")
	}
	if !alive(other.Process.Pid) {
		t.Fatal("a process whose start time did not match was killed")
	}
	if l := OpenLedger(dir); len(l.m) != 0 {
		t.Fatalf("ledger after reap = %v", l.m)
	}
}
