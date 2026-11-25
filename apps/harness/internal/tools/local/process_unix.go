//go:build unix

package local

import (
	"os/exec"
	"syscall"
)

// killGroupOnCancel runs the command in its own process group and makes a cancel (a stopped turn, the timeout)
// kill the whole group: killing only `bash` would leave its children (a `sleep`, a build) running and holding the
// output pipes, so Run would wait for them to end on their own.
func killGroupOnCancel(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil {
			return cmd.Process.Kill()
		}
		return nil
	}
}
