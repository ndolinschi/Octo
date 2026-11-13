package orchestrator

import (
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

func TestCarryOverStaysWithinItsTokenBoundAndKeepsItsOrder(t *testing.T) {
	huge := strings.Repeat("The summary goes on and on. ", 400)
	var tasks []string
	for i := 0; i < 9; i++ {
		tasks = append(tasks, "open task number "+strings.Repeat("x", 200))
	}
	for name, tc := range map[string]struct {
		summary string
		tasks   []string
	}{
		"huge summary, many tasks": {huge, tasks},
		"no tasks":                 {huge, nil},
		"short":                    {"short summary", []string{"one task"}},
		"empty":                    {"", nil},
	} {
		t.Run(name, func(t *testing.T) {
			out := carryOver(tc.summary, tc.tasks)
			if n := projectstore.EstimateTokens(len(out)); n > CarryOverTokens {
				t.Fatalf("carry-over is %d tokens, bound is %d", n, CarryOverTokens)
			}
			s, tk, p := strings.Index(out, "Summary:"), strings.Index(out, "Open tasks:"), strings.Index(out, "recall_message")
			if s < 0 || p < 0 || (len(tc.tasks) > 0 && !(s < tk && tk < p)) || (len(tc.tasks) == 0 && tk >= 0) {
				t.Fatalf("order summary %d, tasks %d, pointer %d in:\n%s", s, tk, p, out)
			}
			if tc.summary == "short summary" && !strings.Contains(out, "short summary") {
				t.Fatalf("a short summary is kept whole: %s", out)
			}
		})
	}
}

func TestStoredSummaryUsesTheLastThreeRequests(t *testing.T) {
	text := func(role, s string) projectstore.Message {
		b := s
		return projectstore.Message{Role: role, Content: []projectstore.ContentBlock{{Type: "text", Text: &b}}}
	}
	live := []projectstore.Message{
		text("user", "first request"), text("assistant", "first answer"),
		text("user", "second request"), text("assistant", "second answer"),
		text("user", "third request"), text("assistant", "third answer"),
		text("user", "fourth request"), text("assistant", "fourth answer"),
	}
	plain := storedSummary("EARLIER SUMMARY", live, false)
	for _, want := range []string{"EARLIER SUMMARY", "second request", "third request", "fourth request"} {
		if !strings.Contains(plain, want) {
			t.Errorf("summary lacks %q:\n%s", want, plain)
		}
	}
	if strings.Contains(plain, "first request") || strings.Contains(plain, "answer") {
		t.Errorf("only the last three requests, no answers:\n%s", plain)
	}
	with := storedSummary("", live, true)
	if !strings.Contains(with, "fourth request -> fourth answer") || strings.Contains(with, "Earlier summary") {
		t.Errorf("with answers:\n%s", with)
	}
}
