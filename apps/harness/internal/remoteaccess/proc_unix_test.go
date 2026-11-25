//go:build unix

package remoteaccess

import (
	"net"
	"os"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func readPids(t *testing.T, bin string) []int {
	t.Helper()
	b, err := os.ReadFile(bin + ".pids")
	if err != nil {
		t.Fatal(err)
	}
	var out []int
	for _, f := range strings.Fields(string(b)) {
		n, err := strconv.Atoi(f)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, n)
	}
	return out
}

// alive is true while the process exists and is not a zombie waiting for its parent.
func alive(pid int) bool {
	if syscall.Kill(pid, 0) != nil {
		return false
	}
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err == nil {
		if f := strings.Fields(string(b)); len(f) > 2 && f[2] == "Z" {
			return false
		}
	}
	return true
}

func dial(addr string) error {
	c, err := net.DialTimeout("tcp", addr, 200*time.Millisecond)
	if err == nil {
		_ = c.Close()
	}
	return err
}
