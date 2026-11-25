package projectstore

import (
	"context"
	"testing"
)

func TestACPSessionRoundTrip(t *testing.T) {
	ctx := context.Background()
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	db, err := st.Create(ctx, NewProject{Name: "p", ModelsJSON: "{}", MaxDepth: 3})
	if err != nil {
		t.Fatal(err)
	}
	orch, err := db.Orchestrator(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok, err := db.ACPSession(ctx, orch.ID); ok || err != nil {
		t.Fatalf("fresh project has a session: %v %v", ok, err)
	}
	want := ACPSession{AgentID: orch.ID, PluginAgent: "claude-code", Model: "acp:claude-code/opus", SessionID: "s-1"}
	if err := db.SaveACPSession(ctx, want); err != nil {
		t.Fatal(err)
	}
	want.SessionID = "s-2"
	if err := db.SaveACPSession(ctx, want); err != nil {
		t.Fatal(err)
	}
	got, ok, err := db.ACPSession(ctx, orch.ID)
	if err != nil || !ok || got != want {
		t.Fatalf("session = %+v ok=%v err=%v, want %+v (upsert)", got, ok, err, want)
	}
	if err := db.DeleteACPSession(ctx, orch.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := db.ACPSession(ctx, orch.ID); ok {
		t.Error("session survived delete")
	}
}
