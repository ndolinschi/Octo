//go:build unix

package proctree

import (
	"os"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// proc is one process of the system as the listing sees it.
type proc struct {
	pid, ppid, sid int
	zombie         bool
}

// Members lists the live processes of leader's session plus every
// descendant of them, leader included while it lives. Zombies are left out.
func Members(leader int) []int {
	if leader <= 1 || leader == os.Getpid() {
		return nil
	}
	if own, err := unix.Getsid(0); err == nil && own == leader {
		return nil // never the harness's own session
	}
	procs := list()
	in := map[int]bool{}
	for _, p := range procs {
		if p.sid == leader || p.pid == leader {
			in[p.pid] = true
		}
	}
	for changed := true; changed; {
		changed = false
		for _, p := range procs {
			if !in[p.pid] && in[p.ppid] {
				in[p.pid], changed = true, true
			}
		}
	}
	self := os.Getpid()
	var out []int
	for _, p := range procs {
		if in[p.pid] && !p.zombie && p.pid != self && p.pid > 1 {
			out = append(out, p.pid)
		}
	}
	return out
}

// KillSession stops leader's session and every descendant: SIGHUP and SIGTERM
// (with SIGCONT for stopped jobs), then SIGKILL to whatever is left after grace.
func KillSession(leader int, grace time.Duration) {
	signal := func(sigs ...syscall.Signal) int {
		pids := Members(leader)
		for _, pid := range pids {
			for _, s := range sigs {
				_ = syscall.Kill(pid, s)
			}
		}
		return len(pids)
	}
	if signal(syscall.SIGHUP, syscall.SIGTERM, syscall.SIGCONT) == 0 {
		return
	}
	deadline := time.Now().Add(grace)
	for time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
		if len(Members(leader)) == 0 {
			return
		}
	}
	for i := 0; i < 20 && signal(syscall.SIGKILL) > 0; i++ {
		time.Sleep(50 * time.Millisecond)
	}
}
