//go:build linux

package terminal

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"syscall"

	"golang.org/x/sys/unix"

	"github.com/ndolinschi/Octo/apps/harness/internal/proctree"
)

func openPTY(cols, rows uint16) (master *os.File, slave *os.File, err error) {
	mfd, err := unix.Open("/dev/ptmx", unix.O_RDWR|unix.O_NOCTTY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, nil, fmt.Errorf("open /dev/ptmx: %w", err)
	}
	master = os.NewFile(uintptr(mfd), "/dev/ptmx")
	if err := unix.IoctlSetPointerInt(mfd, unix.TIOCSPTLCK, 0); err != nil {
		_ = master.Close()
		return nil, nil, fmt.Errorf("unlock pty: %w", err)
	}
	// TIOCGPTPEER (Linux 4.13+) opens the slave fd directly without requiring /dev/pts/<n> chown in user namespaces.
	sfd, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(mfd), uintptr(unix.TIOCGPTPEER), uintptr(unix.O_RDWR|unix.O_NOCTTY))
	if errno == 0 {
		unix.CloseOnExec(int(sfd))
		slave = os.NewFile(sfd, "/dev/pts/peer")
		_ = resizePTY(master, cols, rows)
		return master, slave, nil
	}
	ptyNum, err := unix.IoctlGetInt(mfd, unix.TIOCGPTN)
	if err != nil {
		_ = master.Close()
		return nil, nil, fmt.Errorf("get pty number: %w", err)
	}
	sname := "/dev/pts/" + strconv.Itoa(ptyNum)
	sfdPath, err := unix.Open(sname, unix.O_RDWR|unix.O_NOCTTY|unix.O_CLOEXEC, 0)
	if err != nil {
		_ = master.Close()
		return nil, nil, fmt.Errorf("open %s: %w", sname, err)
	}
	slave = os.NewFile(uintptr(sfdPath), sname)
	_ = resizePTY(master, cols, rows)
	return master, slave, nil
}

func resizePTY(master *os.File, cols, rows uint16) error {
	if master == nil {
		return nil
	}
	return unix.IoctlSetWinsize(int(master.Fd()), unix.TIOCSWINSZ, &unix.Winsize{
		Row: rows,
		Col: cols,
	})
}

func attachPTY(cmd *exec.Cmd, slave *os.File) {
	cmd.Stdin = slave
	cmd.Stdout = slave
	cmd.Stderr = slave
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setsid:  true,
		Setctty: true,
	}
}

func killProcessGroup(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	// The shell is a session leader; its background jobs have process groups of their own but stay in its
	// session (or are its descendants): all of them get SIGHUP and SIGTERM, then SIGKILL after the grace.
	if pid := cmd.Process.Pid; pid > 0 {
		proctree.KillSession(pid, proctree.DefaultGrace)
	}
	_ = cmd.Process.Kill()
}

func isPTYEof(err error) bool {
	return errors.Is(err, io.EOF) || errors.Is(err, syscall.EIO) || errors.Is(err, os.ErrClosed)
}

func defaultShellCandidates() []string {
	return []string{"/bin/bash", "/bin/zsh", "/bin/sh"}
}
