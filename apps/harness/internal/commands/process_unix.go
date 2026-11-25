//go:build unix

package commands

import (
	"os/exec"
	"syscall"

	"github.com/ndolinschi/Octo/apps/harness/internal/proctree"
)

// setProcessGroup starts the command as a session leader (its own process group too): what it starts in the
// background, even in a process group of its own, stays in its session.
func setProcessGroup(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }

// signalGroup sends SIGTERM (or SIGKILL) to the command's whole session and every descendant (proctree.Members),
// then to its process group as before.
func signalGroup(cmd *exec.Cmd, kill bool) {
	if cmd.Process == nil {
		return
	}
	sig := syscall.SIGTERM
	if kill {
		sig = syscall.SIGKILL
	}
	for _, pid := range proctree.Members(cmd.Process.Pid) {
		_ = syscall.Kill(pid, sig)
	}
	if err := syscall.Kill(-cmd.Process.Pid, sig); err != nil {
		// the group may already be gone
		_ = cmd.Process.Signal(sig)
	}
}
