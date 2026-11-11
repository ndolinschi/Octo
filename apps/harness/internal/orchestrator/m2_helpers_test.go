package orchestrator_test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func sleepMs(n int) { time.Sleep(time.Duration(n) * time.Millisecond) }

func (r *rig) firstFolder(t *testing.T, pid string) string {
	t.Helper()
	db, err := r.store.Get(context.Background(), pid)
	if err != nil {
		t.Fatal(err)
	}
	f, err := db.Folders(context.Background())
	if err != nil || len(f) == 0 {
		t.Fatal(err)
	}
	return f[0].Path
}

func writeBig(t *testing.T, dir string, i int) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("file-%03d-with-a-long-name-so-listings-are-large.txt", i)), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func firstUserMessage(t *testing.T, r *rig, pid string) int64 {
	t.Helper()
	db, _ := r.store.Get(context.Background(), pid)
	orch, _ := db.Orchestrator(context.Background())
	msgs, _ := db.Messages(context.Background(), orch.ID)
	for _, m := range msgs {
		if m.Role == "user" {
			return m.ID
		}
	}
	t.Fatal("no user message")
	return 0
}
