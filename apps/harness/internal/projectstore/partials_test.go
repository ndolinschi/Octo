package projectstore

import (
	"context"
	"testing"
)

func TestPartialsAreReplacedTakenOnceAndCleared(t *testing.T) {
	ctx := context.Background()
	db := create(t, newStore(t), "p")
	if err := db.SavePartial(ctx, "a1", "Hel"); err != nil {
		t.Fatal(err)
	}
	if err := db.SavePartial(ctx, "a1", "Hello"); err != nil { // one row per agent, replaced
		t.Fatal(err)
	}
	if err := db.SavePartial(ctx, "a2", "Other"); err != nil {
		t.Fatal(err)
	}
	if err := db.ClearPartial(ctx, "a2"); err != nil {
		t.Fatal(err)
	}
	got, err := db.TakePartials(ctx)
	if err != nil || len(got) != 1 || got[0].AgentID != "a1" || got[0].Text != "Hello" || got[0].UpdatedAt == "" {
		t.Fatalf("TakePartials = %+v, %v", got, err)
	}
	if again, err := db.TakePartials(ctx); err != nil || len(again) != 0 {
		t.Fatalf("second TakePartials = %+v, %v", again, err)
	}
}

func TestTurnAliveIsTakenOnce(t *testing.T) {
	ctx := context.Background()
	db := create(t, newStore(t), "p")
	if at, err := db.TakeTurnAlive(ctx); err != nil || at != "" {
		t.Fatalf("empty TakeTurnAlive = %q, %v", at, err)
	}
	if err := db.TurnAlive(ctx); err != nil {
		t.Fatal(err)
	}
	if err := db.TurnAlive(ctx); err != nil {
		t.Fatal(err)
	}
	if at, err := db.TakeTurnAlive(ctx); err != nil || at == "" {
		t.Fatalf("TakeTurnAlive = %q, %v", at, err)
	}
	if at, _ := db.TakeTurnAlive(ctx); at != "" {
		t.Fatalf("the beat was not removed: %q", at)
	}
}

func TestExchangeKeepsInterrupted(t *testing.T) {
	ctx := context.Background()
	db := create(t, newStore(t), "p")
	e, _, err := db.RecordExchange(ctx, Exchange{TurnID: 7, Request: "r", Status: ExchangeFailed, StartedAt: Now(), Interrupted: true}, SessionGap)
	if err != nil {
		t.Fatal(err)
	}
	got, err := db.ExchangeByID(ctx, e.ID)
	if err != nil || !got.Interrupted || got.Status != ExchangeFailed {
		t.Fatalf("exchange = %+v, %v", got, err)
	}
	// A retry of the turn records it again in place, no longer interrupted.
	if _, _, err := db.RecordExchange(ctx, Exchange{TurnID: 7, Request: "r", Status: ExchangeCompleted, StartedAt: Now()}, SessionGap); err != nil {
		t.Fatal(err)
	}
	if got, _ := db.ExchangeByID(ctx, e.ID); got.Interrupted || got.Status != ExchangeCompleted {
		t.Fatalf("retried exchange = %+v", got)
	}
}
