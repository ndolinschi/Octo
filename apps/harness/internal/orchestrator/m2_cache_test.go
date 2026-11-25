package orchestrator_test

import (
	"context"
	"fmt"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// cacheShare runs turns scripted turns (delegation, a note, an answer: three
// requests each) in a project and returns the orchestrator's cache-read share of
// all its input tokens.
func cacheShare(t *testing.T, mode string, turns int) float64 {
	t.Helper()
	r := newRigWith(t, mockllm.New(0), orchestrator.Options{})
	pid := r.m2Project(t, mode)
	for i := 1; i <= turns; i++ {
		if st := r.run(t, pid, fmt.Sprintf("Request %d: work on module m%d of the project and report back. %s", i, i, filler(10)), nil); st != "completed" {
			t.Fatalf("%s turn %d = %s", mode, i, st)
		}
		waitTurn(t, r, pid)
	}
	db, _ := r.store.Get(context.Background(), pid)
	rows, err := db.UsageRows(context.Background(), "0000", "9999", projectstore.GroupAgent)
	if err != nil {
		t.Fatal(err)
	}
	var read, write, in int64
	for _, row := range rows {
		if row.Label == "orchestrator" {
			read += row.CacheReadTokens
			write += row.CacheWriteTokens
			in += row.InputTokens
		}
	}
	if read+write+in == 0 {
		t.Fatalf("%s: no orchestrator usage", mode)
	}
	return float64(read) / float64(read+write+in)
}

func TestWindowModeCacheShareIsCloseToFull(t *testing.T) {
	full := cacheShare(t, "full", 12)
	window := cacheShare(t, "window", 12)
	t.Logf("cache-read share over 12 scripted turns: full %.1f%%, window %.1f%%", 100*full, 100*window)
	if window < full-0.10 {
		t.Errorf("cache-read share fell from %.1f%% (full) to %.1f%% (window): more than 10 points", 100*full, 100*window)
	}
}
