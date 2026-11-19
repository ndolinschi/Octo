package main

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// A data folder that cannot be written stops the start with the catalogue sentence, the path and what to do, not
// only "lock …: permission denied". Root can write almost anywhere, so the test needs a place the kernel refuses
// (sysfs); without one it is skipped.
func TestServeOnUnwritableDataDir(t *testing.T) {
	emptyEnv(t)
	dir := filepath.Join("/sys", "octo-harness-test-data")
	if err := os.Mkdir(dir, 0o700); err == nil {
		_ = os.Remove(dir)
		t.Skip("could write to /sys")
	} else if !errors.Is(err, fs.ErrPermission) {
		t.Skipf("no unwritable place here: %v", err)
	}
	err := startOnce(t, dir)
	var u *usererr.Error
	if !errors.As(err, &u) || u.Code != usererr.CodeDataDirUnwritable || !strings.Contains(err.Error(), dir) ||
		!strings.Contains(err.Error(), "Octo cannot write to its data folder.") {
		t.Fatalf("serve on an unwritable folder = %v", err)
	}
}

// A non-loopback --addr starts (the token is still required) with a clear warning in the log.
func TestServeWarnsOnNonLoopbackAddr(t *testing.T) {
	emptyEnv(t)
	cfg, _, err := serveConfig([]string{"--data-dir", t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	cfg.APIToken = testAPIToken
	base := startServeWith(t, cfg, "0.0.0.0")
	if status, _ := request(t, "GET", base+"/v1/projects", nil); status != 200 {
		t.Fatalf("GET with the token = %d", status)
	}
	if !strings.Contains(strings.Join(logRing.Lines(200), "\n"), "non-loopback") {
		t.Fatal("no warning about the non-loopback address in the log")
	}
}
