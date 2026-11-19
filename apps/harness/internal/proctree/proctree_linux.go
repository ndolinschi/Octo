//go:build linux

package proctree

import (
	"os"
	"strconv"
	"strings"
)

// stat reads /proc/<pid>/stat: the fields after the command name.
func stat(pid int) ([]string, error) {
	b, err := os.ReadFile("/proc/" + itoa(pid) + "/stat")
	if err != nil {
		return nil, err
	}
	s := string(b)
	i := strings.LastIndexByte(s, ')')
	if i < 0 {
		return nil, errNoProcess
	}
	return strings.Fields(s[i+1:]), nil
}

func list() []proc {
	entries, _ := os.ReadDir("/proc")
	out := make([]proc, 0, len(entries))
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		f, err := stat(pid)
		if err != nil || len(f) < 4 {
			continue
		}
		ppid, _ := strconv.Atoi(f[1])
		sid, _ := strconv.Atoi(f[3])
		out = append(out, proc{pid: pid, ppid: ppid, sid: sid, zombie: f[0] == "Z" || f[0] == "X"})
	}
	return out
}

// StartTime is the process's start time in clock ticks since boot (field 22 of
// /proc/<pid>/stat); it differs between two processes that had the same pid.
func StartTime(pid int) (string, error) {
	f, err := stat(pid)
	if err != nil {
		return "", err
	}
	if len(f) < 20 || f[0] == "Z" {
		return "", errNoProcess
	}
	return f[19], nil
}
