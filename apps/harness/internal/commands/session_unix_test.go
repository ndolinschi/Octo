//go:build unix

package commands_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/proctree"
	"github.com/ndolinschi/Octo/apps/harness/internal/projcfg"
)

// A job started with job control on (its own process group) and one that left the process group with setsid are
// both stopped with the run: the run is a session leader and Stop signals its whole session and descendants.
func TestStopEndsJobsOutsideTheProcessGroup(t *testing.T) {
	f := newFixture(t, projcfg.Command{Name: "jobs", Command: "set -m; sleep 301 >/dev/null 2>&1 & echo $! > a.pid; " +
		"(setsid sleep 302 >/dev/null 2>&1 & echo $! > b.pid; wait) >/dev/null 2>&1 & wait"})
	r := f.start("jobs", "")
	var pids []int
	deadline := time.Now().Add(10 * time.Second)
	for _, name := range []string{"a.pid", "b.pid"} {
		for time.Now().Before(deadline) {
			if b, err := os.ReadFile(filepath.Join(f.folder, name)); err == nil && strings.TrimSpace(string(b)) != "" {
				var n int
				_, _ = fmtSscan(strings.TrimSpace(string(b)), &n)
				pids = append(pids, n)
				break
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	if len(pids) != 2 {
		t.Fatalf("jobs did not start: %v", pids)
	}
	if _, err := f.svc.Stop(context.Background(), f.pid, r.ID); err != nil {
		t.Fatal(err)
	}
	for _, p := range pids {
		gone := false
		for i := 0; i < 150 && !gone; i++ {
			_, err := proctree.StartTime(p)
			gone = err != nil
			if !gone {
				time.Sleep(20 * time.Millisecond)
			}
		}
		if !gone {
			_ = syscall.Kill(p, syscall.SIGKILL)
			t.Fatalf("job %d survived the stop", p)
		}
	}
}
