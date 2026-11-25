//go:build !unix

package remoteaccess

import "os/exec"

func setProcessGroup(*exec.Cmd) {}

// signalGroup: no process groups here (Windows: compiled, not run); the process is killed.
func signalGroup(cmd *exec.Cmd, _ bool) {
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}
