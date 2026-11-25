package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/datalock"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// A second `harness serve` on a data folder in use stops before it opens the
// store (no migration, no restart recovery of the first one's turns) with the
// catalogue's "Another Octo service is already using this data folder".
func TestSecondServeOnOneDataDirStopsBeforeTheStore(t *testing.T) {
	emptyEnv(t)

	// Held by someone else, on a fresh folder: the second start must not create the database.
	fresh := t.TempDir()
	held, err := datalock.Acquire(fresh)
	if err != nil {
		t.Fatal(err)
	}
	err = startOnce(t, fresh)
	if !errors.Is(err, datalock.ErrInUse) || !strings.Contains(err.Error(), "Another Octo service is already using this data folder.") {
		t.Fatalf("serve on a held folder = %v", err)
	}
	var u *usererr.Error
	if !errors.As(err, &u) || u.Code != usererr.CodeDataDirInUse {
		t.Fatalf("error %v is not the catalogue case", err)
	}
	entries, _ := os.ReadDir(fresh)
	for _, e := range entries {
		if e.Name() != datalock.File {
			t.Fatalf("the refused start wrote %s into the data folder", e.Name())
		}
	}
	_ = held.Release()

	// Two real services on one folder: the first serves, the second is refused at once; the first keeps serving.
	dir := t.TempDir()
	cfg, _, err := serveConfig([]string{"--data-dir", dir})
	if err != nil {
		t.Fatal(err)
	}
	cfg.APIToken = testAPIToken
	addr := freeAddr(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- serve(ctx, cfg, addr) }()
	defer func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("first serve: %v", err)
			}
		case <-time.After(15 * time.Second):
			t.Error("first serve did not stop")
		}
	}()
	waitHealth(t, "http://"+addr)
	if err := startOnce(t, dir); !errors.Is(err, datalock.ErrInUse) {
		t.Fatalf("second serve = %v, want the data folder in use", err)
	}
	waitHealth(t, "http://"+addr)

	// Released on exit: after the first stops, the folder starts again.
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("first serve: %v", err)
	}
	done <- nil
	l, err := datalock.Acquire(dir)
	if err != nil {
		t.Fatalf("lock after the service stopped: %v", err)
	}
	_ = l.Release()
}

// startOnce runs serve on dir and returns its error (it must fail at once).
func startOnce(t *testing.T, dir string) error {
	t.Helper()
	cfg, _, err := serveConfig([]string{"--data-dir", dir})
	if err != nil {
		t.Fatal(err)
	}
	cfg.APIToken = testAPIToken
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	res := make(chan error, 1)
	go func() { res <- serve(ctx, cfg, freeAddr(t)) }()
	select {
	case err := <-res:
		return err
	case <-time.After(5 * time.Second):
		cancel()
		<-res
		t.Fatal("serve on a folder in use did not stop")
		return nil
	}
}

func waitHealth(t *testing.T, base string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		resp, err := http.Get(base + "/health")
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("no health at %s: %v", base, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
