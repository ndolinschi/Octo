package acp_test

import (
	"context"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakeacp"
)

type compactionRecHandler struct {
	*recHandler
	compactions []acp.CompactionEvent
	errors      []acp.AgentError
}

func newCompactionRec() *compactionRecHandler {
	return &compactionRecHandler{recHandler: newRec()}
}

func (h *compactionRecHandler) Compaction(_ context.Context, ev acp.CompactionEvent) {
	h.mu.Lock()
	h.compactions = append(h.compactions, ev)
	h.mu.Unlock()
}

func (h *compactionRecHandler) AgentError(_ context.Context, err acp.AgentError) {
	h.mu.Lock()
	h.errors = append(h.errors, err)
	h.mu.Unlock()
}

func TestClientCompactionEvents(t *testing.T) {
	for _, tc := range []struct {
		name       string
		mode       string
		wantStatus []acp.CompactionStatus
		wantSum    string
		wantErr    string
	}{
		{
			name:       "standard acp compaction updates and capability",
			mode:       "acp",
			wantStatus: []acp.CompactionStatus{acp.CompactionInProgress, acp.CompactionInProgress, acp.CompactionCompleted},
			wantSum:    "Compressed summary.",
		},
		{
			name:       "opencode session_info_update compaction",
			mode:       "opencode",
			wantStatus: []acp.CompactionStatus{acp.CompactionInProgress, acp.CompactionCompleted},
		},
		{
			name:       "opencode compaction failed",
			mode:       "fail",
			wantStatus: []acp.CompactionStatus{acp.CompactionInProgress, acp.CompactionFailed},
			wantErr:    "Compaction ran out of context",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			c, err := acp.Start(context.Background(), fakeSpec(dir, map[string]string{
				fakeacp.EnvCommands: "compact|Compact context",
				fakeacp.EnvCompact:  tc.mode,
			}))
			if err != nil {
				t.Fatal(err)
			}
			defer c.Close()

			h := newCompactionRec()
			stop, err := c.Run(context.Background(), dir, "/compact", h)
			if err != nil || stop != acp.StopEndTurn {
				t.Fatalf("Run = %q, %v", stop, err)
			}
			if got := h.text.String(); got != "" {
				t.Fatalf("unexpected text = %q", got)
			}
			if len(h.compactions) != len(tc.wantStatus) {
				t.Fatalf("compactions = %+v, want %d events", h.compactions, len(tc.wantStatus))
			}
			var gotSum, gotErr string
			for i, ev := range h.compactions {
				if ev.Status != tc.wantStatus[i] {
					t.Errorf("compactions[%d].Status = %q, want %q", i, ev.Status, tc.wantStatus[i])
				}
				if ev.Summary != "" {
					gotSum += ev.Summary
				}
				if ev.Error != "" {
					gotErr = ev.Error
				}
			}
			if gotSum != tc.wantSum {
				t.Errorf("summary = %q, want %q", gotSum, tc.wantSum)
			}
			if gotErr != tc.wantErr {
				t.Errorf("error = %q, want %q", gotErr, tc.wantErr)
			}
		})
	}
}

func TestClientAgentErrorHandler(t *testing.T) {
	dir := t.TempDir()
	c, err := acp.Start(context.Background(), fakeSpec(dir, nil))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()

	for _, tc := range []struct {
		marker   string
		wantName string
		wantMsg  string
		wantCode int
	}{
		{fakeacp.MarkerAgentError, "APIError", "Upstream provider rate limit reached", 429},
		{fakeacp.MarkerAgentAuthError, "ProviderAuthError", "Invalid API key", 401},
	} {
		h := newCompactionRec()
		stop, err := c.Run(context.Background(), dir, tc.marker, h)
		if err != nil || stop != acp.StopEndTurn {
			t.Fatalf("%s: Run = %q, %v", tc.marker, stop, err)
		}
		if len(h.errors) != 1 {
			t.Fatalf("%s: errors = %+v, want 1", tc.marker, h.errors)
		}
		got := h.errors[0]
		if got.Name != tc.wantName || got.Message != tc.wantMsg || got.StatusCode != tc.wantCode {
			t.Errorf("%s: got %+v", tc.marker, got)
		}
	}
}
