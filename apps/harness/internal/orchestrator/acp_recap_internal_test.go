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

func TestRecapFallsBackWhenCompactionSummaryIsEmpty(t *testing.T) {
	rt, id := recapRuntime(t)
	m := addText(t, rt, id, "user", "earlier request before compaction")
	if _, err := rt.db.AddManualCompaction(context.Background(), id, "", 0); err != nil {
		t.Fatal(err)
	}
	got, err := rt.recap(context.Background(), id, []projectstore.Message{m})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "user: earlier request before compaction") {
		t.Fatalf("recap = %q, want fallback to recent messages", got)
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

func TestClipMiddlePreservesHeadTailAndUTF8(t *testing.T) {
	s := "HEAD-DESIGN " + strings.Repeat("é", 400) + " TAIL-TASK-3-COMMITTED"
	for n := 1; n < 80; n++ {
		got := clipMiddle(s, n)
		if len(got) > n || !utf8.ValidString(got) {
			t.Fatalf("clipMiddle(%d) = %q (%d bytes)", n, got, len(got))
		}
	}
	got := clipMiddle(s, 120)
	if !strings.Contains(got, "HEAD-DESIGN") || !strings.Contains(got, "TAIL-TASK-3-COMMITTED") {
		t.Fatalf("clipMiddle(120) = %q, want both head and tail", got)
	}
}

func TestRecapIncludesMessagesAfterCompaction(t *testing.T) {
	rt, id := recapRuntime(t)
	m1 := addText(t, rt, id, "user", "old turn before compaction")
	if _, err := rt.db.AddCompaction(context.Background(), id, "SUMMARY of older turns"); err != nil {
		t.Fatal(err)
	}
	m2 := addText(t, rt, id, "user", "now add dark mode")
	m3 := addText(t, rt, id, "assistant", "Dark mode CSS variables added and verified.")
	got, err := rt.recap(context.Background(), id, []projectstore.Message{m1, m2, m3})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) > RecapCap {
		t.Fatalf("recap len = %d > %d", len(got), RecapCap)
	}
	for _, want := range []string{"SUMMARY of older turns", "user: now add dark mode", "assistant: Dark mode CSS variables added and verified."} {
		if !strings.Contains(got, want) {
			t.Errorf("recap missing %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "old turn before compaction") {
		t.Errorf("recap should not repeat messages already covered by compaction:\n%s", got)
	}
}

func TestRecapIncludesRequestInputAnswers(t *testing.T) {
	rt, id := recapRuntime(t)
	m1 := addText(t, rt, id, "user", "I want to create a new project based on react")
	m2, err := rt.db.AppendMessage(context.Background(), id, "assistant",
		[]byte(`[{"type":"tool_use","id":"ri_1","name":"request_input","input":{"title":"Project type"}}]`))
	if err != nil {
		t.Fatal(err)
	}
	m3, err := rt.db.AppendMessage(context.Background(), id, "user",
		[]byte(`[{"type":"tool_result","tool_use_id":"ri_1","content":"{\"status\":\"submitted\",\"values\":{\"kind\":\"Blank starter\",\"pm\":\"pnpm\"}}"}]`))
	if err != nil {
		t.Fatal(err)
	}
	m4, err := rt.db.AppendMessage(context.Background(), id, "assistant",
		[]byte(`[{"type":"tool_use","id":"sh_1","name":"bash","input":{"command":"ls"}}]`))
	if err != nil {
		t.Fatal(err)
	}
	m5, err := rt.db.AppendMessage(context.Background(), id, "user",
		[]byte(`[{"type":"tool_result","tool_use_id":"sh_1","content":"package.json"}]`))
	if err != nil {
		t.Fatal(err)
	}
	got, err := rt.recap(context.Background(), id, []projectstore.Message{m1, m2, m3, m4, m5})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, `user (answered "Project type"): kind=Blank starter, pm=pnpm`) {
		t.Fatalf("recap missing request_input answer:\n%s", got)
	}
	if strings.Contains(got, "package.json") || strings.Contains(got, "bash") {
		t.Fatalf("generic tool rows must stay out of recap:\n%s", got)
	}
}

func TestRecapPreservesOpeningPromptAndLatestProgressOnVerboseTurn(t *testing.T) {
	rt, id := recapRuntime(t)
	var msgs []projectstore.Message
	msgs = append(msgs, addText(t, rt, id, "user", "I want to create a new project based on react"))
	// Simulate 25 KB of implementer/reviewer reports from a single long turn before a crash.
	for i := 0; i < 8; i++ {
		msgs = append(msgs, addText(t, rt, id, "assistant", "Task report "+strings.Repeat("detail ", 500)))
	}
	msgs = append(msgs, addText(t, rt, id, "assistant", "Task 3 committed. Now the visual check with a real browser."))

	got, err := rt.recap(context.Background(), id, msgs)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) > RecapCap || !utf8.ValidString(got) {
		t.Fatalf("recap invalid: len=%d validUTF8=%v", len(got), utf8.ValidString(got))
	}
	if !strings.Contains(got, "user: I want to create a new project based on react") {
		t.Errorf("recap lost the opening user request:\n%s", got)
	}
	if !strings.Contains(got, "Task 3 committed. Now the visual check with a real browser.") {
		t.Errorf("recap lost the latest assistant progress:\n%s", got)
	}
}

func TestFailedRetryBeforeDetection(t *testing.T) {
	rt, id := recapRuntime(t)
	u1 := addText(t, rt, id, "user", "I want to create a new project based on react")
	a1 := addText(t, rt, id, "assistant", "Task 3 committed. Now the visual check.")
	u2 := addText(t, rt, id, "user", "I want to create a new project based on react")
	uDiff := addText(t, rt, id, "user", "actually do something else")

	endedFailed := map[int64]projectstore.TurnEnding{u1.ID: {Status: projectstore.ExchangeFailed}}
	endedStopped := map[int64]projectstore.TurnEnding{u1.ID: {Status: projectstore.ExchangeStopped}}

	if _, ok := failedRetryBefore([]projectstore.Message{u1, a1, u2}, 2, endedFailed); !ok {
		t.Fatal("expected failedRetryBefore=true when retrying a partially-completed failed turn")
	}
	if _, ok := failedRetryBefore([]projectstore.Message{u1, u2}, 1, endedFailed); ok {
		t.Fatal("expected failedRetryBefore=false when previous turn had no assistant output (handled by unansweredBefore)")
	}
	if _, ok := failedRetryBefore([]projectstore.Message{u1, a1, uDiff}, 2, endedFailed); ok {
		t.Fatal("expected failedRetryBefore=false when follow-up prompt text differs")
	}
	if _, ok := failedRetryBefore([]projectstore.Message{u1, a1, u2}, 2, endedStopped); ok {
		t.Fatal("expected failedRetryBefore=false for a user-stopped turn")
	}
	if _, ok := failedRetryBefore([]projectstore.Message{u1, a1, u2}, 2, nil); ok {
		t.Fatal("expected failedRetryBefore=false when previous turn completed")
	}
}

func TestACPTurnPromptAddsContinuationNoteOnLiveAndFreshRetry(t *testing.T) {
	ctx := context.Background()
	store, err := projectstore.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	db, err := store.Create(ctx, projectstore.NewProject{Name: "p", ModelsJSON: `{"orchestrator":"acp:fake"}`, MaxDepth: 3})
	if err != nil {
		t.Fatal(err)
	}
	sid, err := db.DefaultSessionID(ctx)
	if err != nil {
		t.Fatal(err)
	}
	orchSvc := New(store, nil, nil, Options{})
	t.Cleanup(func() { _ = orchSvc.Shutdown(ctx) })
	rt, err := orchSvc.newSessionRuntime(ctx, db, sid)
	if err != nil {
		t.Fatal(err)
	}
	orch, err := db.Orchestrator(ctx)
	if err != nil {
		t.Fatal(err)
	}

	u1 := addText(t, rt, orch.ID, "user", "I want to create a new project based on react")
	_ = addText(t, rt, orch.ID, "assistant", "Task 3 committed. Now the visual check with a real browser.")
	if _, _, err := db.RecordExchange(ctx, projectstore.Exchange{
		SessionID: sid, TurnID: u1.ID, Request: "I want to create a new project based on react",
		Status: projectstore.ExchangeFailed,
	}, 0); err != nil {
		t.Fatal(err)
	}
	_ = addText(t, rt, orch.ID, "user", "I want to create a new project based on react")

	s := &orchSession{}
	livePrompt, err := rt.acpTurnPrompt(ctx, s, orch, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"failed before finishing after making partial progress", "do not start over", "continue from where the previous attempt stopped", "I want to create a new project based on react"} {
		if !strings.Contains(livePrompt, want) {
			t.Errorf("live retry prompt missing %q:\n%s", want, livePrompt)
		}
	}

	freshPrompt, err := rt.acpTurnPrompt(ctx, &orchSession{}, orch, true)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"Earlier in this conversation",
		"Task 3 committed. Now the visual check with a real browser.",
		"failed before finishing after making partial progress",
		"do not start over",
	} {
		if !strings.Contains(freshPrompt, want) {
			t.Errorf("fresh retry prompt missing %q:\n%s", want, freshPrompt)
		}
	}
}

func TestRecapSkipsErroredRequestInputAndPreservesWrappedTitleAndSecrets(t *testing.T) {
	rt, id := recapRuntime(t)
	m1 := addText(t, rt, id, "user", "deploy to staging")
	// Errored / cancelled request_input must NOT be rendered as "user (answered ...)".
	m2, err := rt.db.AppendMessage(context.Background(), id, "assistant",
		[]byte(`[{"type":"tool_use","id":"ri_err","name":"request_input","input":{"title":"Cancelled form"}}]`))
	if err != nil {
		t.Fatal(err)
	}
	m3, err := rt.db.AppendMessage(context.Background(), id, "user",
		[]byte(`[{"type":"tool_result","tool_use_id":"ri_err","is_error":true,"content":"the agent stopped before this tool call finished"}]`))
	if err != nil {
		t.Fatal(err)
	}
	// Wrapped ACP request_input with outer MCP name and nested raw_input.title + secret handle + fenced JSON with leading newline.
	m4, err := rt.db.AppendMessage(context.Background(), id, "assistant",
		[]byte(`[{"type":"tool_use","id":"ri_wrap","name":"other","input":{"title":"octo-harness:request_input","raw_input":{"title":"Staging credentials"}}}]`))
	if err != nil {
		t.Fatal(err)
	}
	m5, err := rt.db.AppendMessage(context.Background(), id, "user",
		[]byte(`[{"type":"tool_result","tool_use_id":"ri_wrap","content":"\n`+"```json\\n{\\\"status\\\":\\\"submitted\\\",\\\"values\\\":{\\\"region\\\":\\\"us-east-1\\\"},\\\"use_as\\\":{\\\"api_key\\\":\\\"secret:api_key\\\"}}\\n```"+`"}]`))
	if err != nil {
		t.Fatal(err)
	}
	got, err := rt.recap(context.Background(), id, []projectstore.Message{m1, m2, m3, m4, m5})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(got, "Cancelled form") || strings.Contains(got, "stopped before this tool call") {
		t.Errorf("errored request_input must be omitted from recap:\n%s", got)
	}
	if !strings.Contains(got, `user (answered "Staging credentials"): region=us-east-1, api_key=secret:api_key`) {
		t.Errorf("wrapped request_input title/values/secret handle missing:\n%s", got)
	}
}

func TestRecapDynamicBudgetForShortConversationAndLargeCompactionSummary(t *testing.T) {
	rt, id := recapRuntime(t)
	// Two messages: 50B user + 9KB assistant should use most of RecapCap (not shrink to ~2KB).
	u := addText(t, rt, id, "user", "build the service")
	a := addText(t, rt, id, "assistant", "START "+strings.Repeat("x", 9000)+" END")
	got, err := rt.recap(context.Background(), id, []projectstore.Message{u, a})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) > RecapCap || len(got) < 3500 {
		t.Fatalf("2-message recap len = %d, want well-utilized budget <= %d", len(got), RecapCap)
	}
	if !strings.Contains(got, "START") || !strings.Contains(got, "END") {
		t.Fatalf("2-message recap must keep start and end:\n%.120s ... %.120s", got, got[max(0, len(got)-120):])
	}

	// Compaction summary of 7000B + tiny 30B post-compaction message: summary must NOT be halved to 4000B.
	rt2, id2 := recapRuntime(t)
	m1 := addText(t, rt2, id2, "user", "old")
	bigSummary := "SUMHEAD " + strings.Repeat("s", 6800) + " SUMTAIL"
	if _, err := rt2.db.AddCompaction(context.Background(), id2, bigSummary); err != nil {
		t.Fatal(err)
	}
	m2 := addText(t, rt2, id2, "user", "quick follow-up")
	got2, err := rt2.recap(context.Background(), id2, []projectstore.Message{m1, m2})
	if err != nil {
		t.Fatal(err)
	}
	if len(got2) > RecapCap {
		t.Fatalf("compaction recap len = %d > %d", len(got2), RecapCap)
	}
	if !strings.Contains(got2, "SUMTAIL") || !strings.Contains(got2, "user: quick follow-up") {
		t.Fatalf("compaction recap truncated summary needlessly (len=%d)", len(got2))
	}
}
