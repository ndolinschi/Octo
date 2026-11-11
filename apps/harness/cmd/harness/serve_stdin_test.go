package main

import (
	"bytes"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestWatchStdinStopsAtEOFOnly(t *testing.T) {
	stopped := make(chan struct{})
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	go watchStdin(r, func() { close(stopped) })
	_, _ = w.WriteString("some input is not a reason to stop\n")
	select {
	case <-stopped:
		t.Fatal("stopped before EOF")
	case <-time.After(100 * time.Millisecond):
	}
	_ = w.Close()
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("did not stop at EOF")
	}
}

func TestExitOnStdinCloseFlagAndEnv(t *testing.T) {
	emptyEnv(t)
	cfg, _, err := serveConfig([]string{"--data-dir", t.TempDir()})
	if err != nil || cfg.ExitOnStdinClose {
		t.Fatalf("default: %v %v", cfg.ExitOnStdinClose, err)
	}
	if cfg, _, err = serveConfig([]string{"--data-dir", t.TempDir(), "--exit-on-stdin-close"}); err != nil || !cfg.ExitOnStdinClose {
		t.Fatalf("flag: %v %v", cfg.ExitOnStdinClose, err)
	}
	t.Setenv("HARNESS_EXIT_ON_STDIN_CLOSE", "1")
	if cfg, _, err = serveConfig([]string{"--data-dir", t.TempDir()}); err != nil || !cfg.ExitOnStdinClose {
		t.Fatalf("env: %v %v", cfg.ExitOnStdinClose, err)
	}
}

// helperServe is the re-executed process of TestHarnessExitsWhenStdinCloses.
func TestHelperServe(t *testing.T) {
	if os.Getenv("HARNESS_TEST_HELPER_SERVE") != "1" {
		t.Skip("helper process")
	}
	if err := cmdServe([]string{"--addr", os.Getenv("HARNESS_TEST_ADDR"), "--data-dir", os.Getenv("HARNESS_TEST_DATA")}); err != nil {
		t.Fatal(err)
	}
}

func TestHarnessExitsWhenStdinCloses(t *testing.T) {
	cmd := exec.Command(os.Args[0], "-test.run=^TestHelperServe$")
	cmd.Env = append(os.Environ(), "HARNESS_TEST_HELPER_SERVE=1", "HARNESS_TEST_ADDR="+freeAddr(t), "HARNESS_TEST_DATA="+t.TempDir(),
		"HARNESS_EXIT_ON_STDIN_CLOSE=1", "HARNESS_NO_BUILTIN_PLUGINS=1")
	out := &lockedBuf{}
	cmd.Stdout, cmd.Stderr = out, out
	in, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill() })
	deadline := time.Now().Add(15 * time.Second)
	for !strings.Contains(out.String(), "harness serving") {
		if time.Now().After(deadline) {
			t.Fatalf("harness did not start: %s", out.String())
		}
		time.Sleep(50 * time.Millisecond)
	}
	_ = in.Close() // the parent "dies"
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("exit: %v\n%s", err, out.String())
		}
	case <-time.After(15 * time.Second):
		t.Fatalf("harness still running after stdin closed:\n%s", out.String())
	}
	if !strings.Contains(out.String(), "shutting down") {
		t.Fatalf("no graceful shutdown in the log:\n%s", out.String())
	}
}

type lockedBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuf) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}
