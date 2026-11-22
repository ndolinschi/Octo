package projectstore

import (
	"context"
	"testing"
)

func TestToolDurationsAreStoredBesideTheContent(t *testing.T) {
	ctx := context.Background()
	d := create(t, newStore(t), "p")
	orch, _ := d.Orchestrator(ctx)
	const body = `[{"type":"tool_result","tool_use_id":"a","content":"ok","is_error":false},{"type":"tool_result","tool_use_id":"b","content":"ok","is_error":false}]`
	m, err := d.AppendMessage(ctx, orch.ID, "user", []byte(body))
	if err != nil {
		t.Fatal(err)
	}
	if err := d.SetToolDurations(ctx, m.ID, ToolDurations{"a": 1250, "x": 3}); err != nil {
		t.Fatal(err)
	}
	list, err := d.Messages(ctx, orch.ID)
	if err != nil || len(list) != 1 {
		t.Fatalf("messages = %v, %v", list, err)
	}
	a, b := list[0].Content[0], list[0].Content[1]
	if a.DurationMs == nil || *a.DurationMs != 1250 {
		t.Fatalf("a = %v", a.DurationMs)
	}
	if b.DurationMs != nil {
		t.Fatalf("b was never timed, got %d", *b.DurationMs)
	}
	// The stored content (what the model is sent again) is untouched.
	if string(list[0].Raw) != body {
		t.Fatalf("raw content changed: %s", list[0].Raw)
	}
}
