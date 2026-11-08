package tools

import (
	"context"
	"encoding/json"
	"testing"
)

func TestRegisterDuplicate(t *testing.T) {
	r := NewRegistry()
	h := func(ctx context.Context, input json.RawMessage) (string, bool, error) {
		return "ok", false, nil
	}
	d := Def{
		Name:        "echo",
		Description: "echo",
		InputSchema: json.RawMessage(`{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}`),
		Handle:      h,
	}
	if err := r.Register(d); err != nil {
		t.Fatalf("Register: %v", err)
	}
	if err := r.Register(d); err == nil {
		t.Fatal("expected error registering duplicate name")
	}
}
