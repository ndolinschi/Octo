package orchestrator

import (
	"context"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

func recapRuntime(t *testing.T) (*runtime, string) {
	t.Helper()
	store, err := projectstore.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	db, err := store.Create(context.Background(), projectstore.NewProject{Name: "p", ModelsJSON: "{}", MaxDepth: 3})
	if err != nil {
		t.Fatal(err)
	}
	orch, err := db.Orchestrator(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return &runtime{db: db}, orch.ID
}

func addText(t *testing.T, rt *runtime, agentID, role, text string) projectstore.Message {
	t.Helper()
	m, err := rt.db.AppendMessage(context.Background(), agentID, role, []byte(`[{"type":"text","text":`+quote(text)+`}]`))
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func quote(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`).Replace(s) + `"`
}

func TestRecapIsEmptyWithoutHistory(t *testing.T) {
	rt, id := recapRuntime(t)
	got, err := rt.recap(context.Background(), id, nil)
	if err != nil || got != "" {
		t.Fatalf("recap = %q, %v", got, err)
	}
}

func TestRecapKeepsTheNewestTextsWithinTheCap(t *testing.T) {
	rt, id := recapRuntime(t)
	var msgs []projectstore.Message
	for i := 0; i < 30; i++ {
		role := "user"
		if i%2 == 1 {
			role = "assistant"
		}
		msgs = append(msgs, addText(t, rt, id, role, strings.Repeat("x", 600)+" #"+strings.Repeat("n", i%5)+string(rune('a'+i%26))))
	}
	got, err := rt.recap(context.Background(), id, msgs)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) > RecapCap {
		t.Errorf("recap is %d bytes, cap is %d", len(got), RecapCap)
	}
	if !utf8.ValidString(got) {
		t.Error("recap is not valid UTF-8")
	}
	lines := strings.Split(got, "\n")
	if want := "assistant: "; !strings.HasPrefix(lines[len(lines)-1], want) {
		t.Errorf("the newest text must come last, got %.30q", lines[len(lines)-1])
	}
	if len(lines) >= 30 {
		t.Errorf("the cap must drop the oldest texts, kept %d lines", len(lines))
	}
}

func TestRecapIsAtMostFortyMessagesAndSkipsToolRows(t *testing.T) {
	rt, id := recapRuntime(t)
	var msgs []projectstore.Message
	for i := 0; i < 60; i++ {
		msgs = append(msgs, addText(t, rt, id, "user", "m"))
	}
	tool, err := rt.db.AppendMessage(context.Background(), id, "assistant", []byte(`[{"type":"tool_use","id":"t","name":"x","input":{}}]`))
	if err != nil {
		t.Fatal(err)
	}
	msgs = append(msgs, tool)
	got, err := rt.recap(context.Background(), id, msgs)
	if err != nil {
		t.Fatal(err)
	}
	if n := len(strings.Split(got, "\n")); n != recapMaxMessages {
		t.Errorf("recap has %d lines, want %d", n, recapMaxMessages)
	}
	if strings.Contains(got, "tool_use") {
		t.Errorf("tool rows must not be in the recap: %q", got)
	}
}

func TestRecapPrefersTheLatestCompactionSummary(t *testing.T) {
	rt, id := recapRuntime(t)
	m := addText(t, rt, id, "user", "an old question")
	if _, err := rt.db.AddCompaction(context.Background(), id, "SUMMARY of the project so far"); err != nil {
		t.Fatal(err)
	}
	got, err := rt.recap(context.Background(), id, []projectstore.Message{m})
	if err != nil || got != "SUMMARY of the project so far" {
		t.Fatalf("recap = %q, %v", got, err)
	}
	if got, _ := rt.recap(context.Background(), id, nil); got != "" {
		t.Errorf("no earlier messages means no recap, got %q", got)
	}
}

func TestClipKeepsRunesWhole(t *testing.T) {
	s := strings.Repeat("é", 100)
	for n := 1; n < 40; n++ {
		if got := clip(s, n); len(got) > n || !utf8.ValidString(got) {
			t.Fatalf("clip(%d) = %q (%d bytes)", n, got, len(got))
		}
	}
	if clip("short", 100) != "short" {
		t.Error("short text must not change")
	}
}
