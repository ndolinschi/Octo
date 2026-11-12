//go:build !unix

package commands

import "os/exec"

func setProcessGroup(*exec.Cmd) {}

func signalGroup(cmd *exec.Cmd, _ bool) {
	if cmd.Process != nil {
		// no process groups here: end the process itself
		_ = cmd.Process.Kill()
	}
}
