//go:build !unix

package lsp

import "os/exec"

func setProcessGroup(*exec.Cmd) {}

func killGroup(cmd *exec.Cmd) {
	if cmd.Process != nil {
		// shortcut: the process may already be gone; nothing to report.
		_ = cmd.Process.Kill()
	}
}
