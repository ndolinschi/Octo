//go:build unix

package remoteaccess

import (
	"os/exec"
	"syscall"
)

func setProcessGroup(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }

// signalGroup sends sig to the command's whole process group (cloudflared may start helpers).
func signalGroup(cmd *exec.Cmd, kill bool) {
	if cmd.Process == nil {
		return
	}
	sig := syscall.SIGTERM
	if kill {
		sig = syscall.SIGKILL
	}
	if err := syscall.Kill(-cmd.Process.Pid, sig); err != nil {
		// shortcut: the group may already be gone; fall back to the process itself.
		_ = cmd.Process.Signal(sig)
	}
}
