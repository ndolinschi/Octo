//go:build unix

package datalock

import (
	"bufio"
	"errors"
	"os"
	"os/exec"
	"testing"
	"time"
)

// TestHelperHold is the child of TestKilledHolderLeavesNoStaleLock: it takes
// the lock, says so, and waits to be killed.
func TestHelperHold(t *testing.T) {
	dir := os.Getenv("DATALOCK_HOLD")
	if dir == "" {
		t.Skip("helper")
	}
	if _, err := Acquire(dir); err != nil {
		t.Fatal(err)
	}
	os.Stdout.WriteString("held\n")
	time.Sleep(time.Minute)
}

func TestKilledHolderLeavesNoStaleLock(t *testing.T) {
	dir := t.TempDir()
	cmd := exec.Command(os.Args[0], "-test.run=^TestHelperHold$")
	cmd.Env = append(os.Environ(), "DATALOCK_HOLD="+dir)
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	if line, _ := bufio.NewReader(out).ReadString('\n'); line != "held\n" {
		_ = cmd.Process.Kill()
		t.Fatalf("child said %q", line)
	}
	if _, err := Acquire(dir); !errors.Is(err, ErrInUse) {
		t.Fatalf("Acquire while the child holds it = %v", err)
	}
	_ = cmd.Process.Kill() // SIGKILL: no cleanup runs in the child
	_ = cmd.Wait()
	l, err := Acquire(dir)
	if err != nil {
		t.Fatalf("Acquire after the holder was killed = %v", err)
	}
	_ = l.Release()
}
