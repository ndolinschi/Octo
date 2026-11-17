package terminal

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func readUntil(t *testing.T, ch <-chan []byte, needle string, timeout time.Duration) string {
	t.Helper()
	var buf strings.Builder
	deadline := time.After(timeout)
	for {
		select {
		case chunk, ok := <-ch:
			if !ok {
				t.Fatalf("channel closed before seeing %q; got %q", needle, buf.String())
			}
			buf.Write(chunk)
			if strings.Contains(buf.String(), needle) {
				return buf.String()
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %q; got %q", needle, buf.String())
		}
	}
}

func TestInteractivePTYResizeReplayAndExit(t *testing.T) {
	ctx := context.Background()
	mgr := NewManager(Options{MaxPerProject: 2, IdleTimeout: 10 * time.Second})
	defer func() { _ = mgr.Shutdown(ctx) }()

	sess, err := mgr.Start(ctx, "prj_1", Spec{
		Command: "/bin/sh",
		Dir:     t.TempDir(),
		Cols:    90,
		Rows:    28,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	ch, release, err := sess.Subscribe()
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}

	if err := sess.WriteInput(ctx, []byte("tty; test -t 0 && echo IS_A_TTY; echo R\"\"EADY_ONE\n")); err != nil {
		t.Fatalf("WriteInput: %v", err)
	}
	out := readUntil(t, ch, "READY_ONE", 5*time.Second)
	if !strings.Contains(out, "IS_A_TTY") || !strings.Contains(out, "/dev/pts/") {
		t.Fatalf("expected interactive /dev/pts/ TTY in output, got %q", out)
	}

	if err := sess.Resize(132, 43); err != nil {
		t.Fatalf("Resize: %v", err)
	}
	if err := sess.WriteInput(ctx, []byte("stty size; echo S\"\"IZE_DONE\n")); err != nil {
		t.Fatalf("WriteInput stty: %v", err)
	}
	sizeOut := readUntil(t, ch, "SIZE_DONE", 5*time.Second)
	if !strings.Contains(sizeOut, "43 132") {
		t.Fatalf("expected resized dimensions '43 132' in stty output, got %q", sizeOut)
	}

	// Re-subscribing after release replays recent scrollback.
	release()
	ch2, release2, err := sess.Subscribe()
	if err != nil {
		t.Fatalf("re-Subscribe: %v", err)
	}
	defer release2()
	replayOut := readUntil(t, ch2, "SIZE_DONE", 2*time.Second)
	if !strings.Contains(replayOut, "READY_ONE") {
		t.Fatalf("expected replay buffer to include earlier output, got %q", replayOut)
	}

	// Graceful exit via shell command.
	if err := sess.WriteInput(ctx, []byte("exit 0\n")); err != nil {
		t.Fatalf("WriteInput exit: %v", err)
	}
	exitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	info, err := sess.Exit(exitCtx)
	if err != nil {
		t.Fatalf("Exit: %v", err)
	}
	if info.Code != 0 {
		t.Fatalf("expected exit code 0, got %+v", info)
	}
}

func TestMaxPerProjectAndClose(t *testing.T) {
	ctx := context.Background()
	mgr := NewManager(Options{MaxPerProject: 1, IdleTimeout: 10 * time.Second})
	defer func() { _ = mgr.Shutdown(ctx) }()

	s1, err := mgr.Start(ctx, "prj_limit", Spec{Command: "/bin/sh", Dir: t.TempDir()})
	if err != nil {
		t.Fatalf("Start s1: %v", err)
	}
	if _, err := mgr.Start(ctx, "prj_limit", Spec{Command: "/bin/sh", Dir: t.TempDir()}); !errors.Is(err, ErrTooManySessions) {
		t.Fatalf("expected ErrTooManySessions, got %v", err)
	}
	if list := mgr.ListProject("prj_limit"); len(list) != 1 || list[0].ID != s1.ID {
		t.Fatalf("unexpected ListProject: %+v", list)
	}
	if err := mgr.Close("prj_limit", s1.ID); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if _, err := mgr.Get("prj_limit", s1.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound after Close, got %v", err)
	}
}
