//go:build darwin

package proctree

import (
	"os/exec"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

// list asks ps (macOS has no /proc) and reads each session id with getsid.
func list() []proc {
	out, err := exec.Command("ps", "-axo", "pid=,ppid=,stat=").Output()
	if err != nil {
		return nil
	}
	var procs []proc
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Fields(line)
		if len(f) < 3 {
			continue
		}
		pid, _ := strconv.Atoi(f[0])
		ppid, _ := strconv.Atoi(f[1])
		sid, err := unix.Getsid(pid)
		if err != nil {
			continue
		}
		procs = append(procs, proc{pid: pid, ppid: ppid, sid: sid, zombie: strings.HasPrefix(f[2], "Z")})
	}
	return procs
}

// StartTime is the process's start time as ps prints it (to the second).
func StartTime(pid int) (string, error) {
	out, err := exec.Command("ps", "-o", "lstart=", "-p", itoa(pid)).Output()
	s := strings.TrimSpace(string(out))
	if err != nil || s == "" {
		return "", errNoProcess
	}
	return s, nil
}
