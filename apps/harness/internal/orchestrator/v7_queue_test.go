package orchestrator_test

import (
	"context"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

func TestFailedTurnPausesQueueUntilResumed(t *testing.T) {
	gate := make(chan struct{})
	var requests atomic.Int32
	r := newRig(t, http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		requests.Add(1)
		<-gate
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"type":"error","error":{"type":"invalid_request_error","message":"nope"}}`))
	}))
	pid := r.project(t, 1)
	ctx := context.Background()
	ch, cancel := r.hub.Subscribe(pid)
	defer cancel()
	if _, q, err := r.orch.Submit(ctx, pid, "one"); err != nil || q != nil {
		t.Fatalf("first submit: %v %v", q, err)
	}
	if _, q, err := r.orch.Submit(ctx, pid, "two"); err != nil || q == nil {
		t.Fatalf("second submit was not queued: %v %v", q, err)
	}
	close(gate)
	waitEvent := func(typ string, ok func(map[string]any) bool) {
		t.Helper()
		deadline := time.After(20 * time.Second)
		for {
			select {
			case ev := <-ch:
				if ev.Type != typ {
					continue
				}
				m := (collected{events: []events.Event{ev}}).of(typ)[0]
				if ok == nil || ok(m) {
					return
				}
			case <-deadline:
				t.Fatalf("no %s event", typ)
			}
		}
	}
	waitEvent(events.TurnFinished, func(m map[string]any) bool { return m["status"] == "failed" })
	waitEvent(events.QueueUpdated, func(m map[string]any) bool { return m["paused"] == true })
	msgs, paused, err := r.orch.Queue(ctx, pid)
	if err != nil || !paused || len(msgs) != 1 || msgs[0].Text != "two" {
		t.Fatalf("queue = %+v paused=%v err=%v", msgs, paused, err)
	}
	time.Sleep(100 * time.Millisecond)
	if r.orch.Running(pid) {
		t.Fatal("the queue ran on top of a failed turn")
	}
	// A message sent now (no turn running) is not held back by the paused queue.
	// Resume: the queued message runs (and fails again), and the queue is empty.
	if err := r.orch.ResumeQueue(ctx, pid); err != nil {
		t.Fatal(err)
	}
	waitEvent(events.TurnFinished, nil)
	msgs, _, _ = r.orch.Queue(ctx, pid)
	if len(msgs) != 0 || requests.Load() < 2 {
		t.Fatalf("after resume: queue=%+v requests=%d", msgs, requests.Load())
	}
}

func TestQueueSurvivesARestartPaused(t *testing.T) {
	dir := t.TempDir()
	store, err := projectstore.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	db, err := store.Create(ctx, projectstore.NewProject{Name: "p", ModelsJSON: "{}", MaxDepth: 1, OrchestratorModel: "m"})
	if err != nil {
		t.Fatal(err)
	}
	pid := db.ID()
	for _, text := range []string{"a", "b", "c"} {
		if _, err := db.Enqueue(ctx, text); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	store, err = projectstore.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	hub := events.NewHub()
	svc := project.NewService(store, hub, nil, project.Defaults{Models: config.DefaultModels(), MaxDepth: 3})
	if err := svc.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	db, err = store.Get(ctx, pid)
	if err != nil {
		t.Fatal(err)
	}
	msgs, paused, err := db.Queue(ctx)
	if err != nil || !paused || len(msgs) != 3 || msgs[0].Text != "a" || msgs[2].Text != "c" {
		t.Fatalf("queue after restart = %+v paused=%v err=%v", msgs, paused, err)
	}
}
