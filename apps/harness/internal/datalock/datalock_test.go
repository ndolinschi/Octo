package datalock

import (
	"errors"
	"testing"
)

func TestSecondAcquireFailsUntilReleased(t *testing.T) {
	dir := t.TempDir()
	first, err := Acquire(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Acquire(dir); !errors.Is(err, ErrInUse) {
		t.Fatalf("second Acquire = %v, want ErrInUse", err)
	}
	if err := first.Release(); err != nil {
		t.Fatal(err)
	}
	again, err := Acquire(dir)
	if err != nil {
		t.Fatalf("Acquire after Release = %v", err)
	}
	_ = again.Release()
	_ = again.Release() // twice is harmless
}

func TestAcquireCreatesTheDirectory(t *testing.T) {
	l, err := Acquire(t.TempDir() + "/new/data")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Release()
}
