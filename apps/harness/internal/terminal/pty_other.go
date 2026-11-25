//go:build !linux && !darwin

package terminal

import (
	"errors"
	"io"
	"os"
	"os/exec"
)

func openPTY(_, _ uint16) (master *os.File, slave *os.File, err error) {
	return nil, nil, errors.New("native pty unsupported on this platform")
}

func resizePTY(_ *os.File, _, _ uint16) error { return nil }

func attachPTY(_ *exec.Cmd, _ *os.File) {}

func killProcessGroup(cmd *exec.Cmd) {
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}

func isPTYEof(err error) bool {
	return errors.Is(err, io.EOF) || errors.Is(err, os.ErrClosed)
}

func defaultShellCandidates() []string {
	if comspec := os.Getenv("COMSPEC"); comspec != "" {
		return []string{comspec}
	}
	return []string{"powershell.exe", "cmd.exe"}
}
