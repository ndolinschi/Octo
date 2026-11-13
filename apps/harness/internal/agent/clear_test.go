package agent

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/anthropics/anthropic-sdk-go/v2"
)

func history(calls int, resultLines int) []anthropic.MessageParam {
	msgs := []anthropic.MessageParam{anthropic.NewUserMessage(anthropic.NewTextBlock("go"))}
	for i := 0; i < calls; i++ {
		id := fmt.Sprintf("t%d", i)
		msgs = append(msgs,
			anthropic.NewAssistantMessage(anthropic.NewToolUseBlock(id, map[string]any{"path": fmt.Sprintf("src/f%d.go", i)}, "read_file")),
			anthropic.NewUserMessage(anthropic.NewToolResultBlock(id, strings.Repeat("line of code\n", resultLines), false)))
	}
	return msgs
}

func text(t *testing.T, msgs []anthropic.MessageParam) string {
	t.Helper()
	b, err := json.Marshal(msgs)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestClearingStartsAtTheShareOfTheWindowAndKeepsTheLastFive(t *testing.T) {
	msgs := history(12, 200) // ~2600 bytes per result, ~31 kB: ~8k tokens
	orig := text(t, msgs)
	// Below 60%: untouched.
	if out, n := (ClearPolicy{WindowTokens: 100000}).Apply(0, 0, msgs); n != 0 || text(t, out) != orig {
		t.Fatalf("cleared %d below the threshold", n)
	}
	out, n := (ClearPolicy{WindowTokens: 10000}).Apply(0, 0, msgs) // 8k > 6k
	if n != 7 {
		t.Fatalf("cleared %d results, want 7 (12 minus the last 5)", n)
	}
	got := text(t, out)
	for i := 0; i < 7; i++ {
		if !strings.Contains(got, fmt.Sprintf("[cleared: read_file src/f%d.go, 201 lines]", i)) {
			t.Errorf("no stub for call %d", i)
		}
	}
	if strings.Count(got, "line of code") != 5*200 {
		t.Errorf("the last five results were not kept whole")
	}
	// The input is not changed (the stored history stays whole).
	if text(t, msgs) != orig {
		t.Fatal("the input messages were modified")
	}
	// Idempotent: a second pass clears nothing more and keeps the stubs.
	again, n2 := (ClearPolicy{WindowTokens: 10000}).Apply(0, 0, out)
	if n2 != 0 || text(t, again) != got {
		t.Fatalf("second pass cleared %d", n2)
	}
	// Fewer results than Keep: nothing to clear however large.
	if _, n := (ClearPolicy{WindowTokens: 1000}).Apply(0, 0, history(4, 200)); n != 0 {
		t.Fatalf("cleared %d with only 4 results", n)
	}
	// System and tool sizes count toward the threshold.
	if _, n := (ClearPolicy{WindowTokens: 40000}).Apply(60000, 60000, msgs); n != 7 {
		t.Fatalf("system and tools were not counted: %d", n)
	}
}

func TestStubForASingleLineResultAndACommand(t *testing.T) {
	call := map[string]any{"name": "bash", "input": map[string]any{"command": "go test ./... -run Something"}}
	if got := stub(call, "ok"); got != "[cleared: bash go test ./... -run Something, 2 bytes]" {
		t.Fatalf("stub = %q", got)
	}
}
