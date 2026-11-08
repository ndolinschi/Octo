package store

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestOpenCreateSessionAppend(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()

	s, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })

	wantDB := filepath.Join(dir, "harness.sqlite")
	if _, err := os.Stat(wantDB); err != nil {
		t.Fatalf("expected database at %s: %v", wantDB, err)
	}

	sessionID, err := s.CreateSession(ctx, "claude-test")
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if sessionID == "" {
		t.Fatal("CreateSession returned empty sessionID")
	}

	if err := s.AppendMessage(ctx, sessionID, "user", []byte(`{"text":"hello"}`)); err != nil {
		t.Fatalf("AppendMessage user: %v", err)
	}
	if err := s.AppendMessage(ctx, sessionID, "assistant", []byte(`{"text":"hi"}`)); err != nil {
		t.Fatalf("AppendMessage assistant: %v", err)
	}

	n, err := s.MessageCount(ctx, sessionID)
	if err != nil {
		t.Fatalf("MessageCount before close: %v", err)
	}
	if n != 2 {
		t.Fatalf("MessageCount = %d, want 2", n)
	}

	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	s2, err := Open(dir)
	if err != nil {
		t.Fatalf("reopen Open: %v", err)
	}
	t.Cleanup(func() { _ = s2.Close() })

	n, err = s2.MessageCount(ctx, sessionID)
	if err != nil {
		t.Fatalf("MessageCount after reopen: %v", err)
	}
	if n != 2 {
		t.Fatalf("MessageCount after reopen = %d, want 2", n)
	}
}

func TestListSessionsAndGetMessages(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })

	sessionID, err := s.CreateSession(ctx, "m1")
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	_ = s.AppendMessage(ctx, sessionID, "user", []byte(`{"role":"user"}`))

	sessions, err := s.ListSessions(ctx)
	if err != nil {
		t.Fatalf("ListSessions: %v", err)
	}
	if len(sessions) != 1 || sessions[0].ID != sessionID {
		t.Fatalf("ListSessions = %+v", sessions)
	}

	msgs, err := s.GetMessages(ctx, sessionID)
	if err != nil {
		t.Fatalf("GetMessages: %v", err)
	}
	if len(msgs) != 1 || msgs[0].Role != "user" {
		t.Fatalf("GetMessages = %+v", msgs)
	}
}
