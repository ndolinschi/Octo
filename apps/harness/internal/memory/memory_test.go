package memory

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

const secretValue = "sk-memory-secret-Zq81xT0pL9"

type rig struct {
	t      *testing.T
	svc    *Service
	db     *projectstore.DB
	orch   string
	events []string
}

func newRig(t *testing.T) *rig {
	t.Helper()
	store, err := projectstore.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	db, err := store.Create(context.Background(), projectstore.NewProject{Name: "p", ModelsJSON: "{}", MaxDepth: 1, OrchestratorModel: "m"})
	if err != nil {
		t.Fatal(err)
	}
	orch, err := db.Orchestrator(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	r := &rig{t: t, db: db, orch: orch.ID}
	db.SetRedactor(func(s string) string { return strings.ReplaceAll(s, secretValue, "[secret]") })
	r.svc = &Service{DB: db, Redact: func(s string) string { return strings.ReplaceAll(s, secretValue, "[secret]") },
		Publish: func(typ string, _ map[string]any) { r.events = append(r.events, typ) }}
	return r
}

func (r *rig) say(role, text string) projectstore.Message {
	r.t.Helper()
	b, _ := json.Marshal([]map[string]any{{"type": "text", "text": text}})
	m, err := r.db.AppendMessage(context.Background(), r.orch, role, b)
	if err != nil {
		r.t.Fatal(err)
	}
	return m
}

func (r *rig) search(q string, opts ...func(*SearchParams)) SearchResult {
	r.t.Helper()
	p := SearchParams{Query: q}
	for _, o := range opts {
		o(&p)
	}
	res, err := r.svc.Search(context.Background(), p)
	if err != nil {
		r.t.Fatal(err)
	}
	return res
}

func TestRussianInflectedFormIsFound(t *testing.T) {
	r := newRig(t)
	m := r.say("user", "Нужно уложиться в бюджет проекта, не больше пяти долларов")
	for _, q := range []string{"бюджета", "БЮДЖЕТОМ", "бюджет", "бюджетами проекта"} {
		res := r.search(q)
		if len(res.Hits) == 0 || res.Hits[0].ID != fmt.Sprint(m.ID) || res.Hits[0].Kind != "message" {
			t.Errorf("%q: %+v", q, res)
		}
	}
	// An unrelated word finds nothing and says so.
	res := r.search("кораблестроение")
	if len(res.Hits) != 0 || res.Message != NothingMatches {
		t.Fatalf("res = %+v", res)
	}
	// Exact-word hits come before substring hits.
	r.say("assistant", "бюджетирование это отдельная тема")
	res = r.search("бюджет")
	if len(res.Hits) < 2 || res.Hits[0].ID != fmt.Sprint(m.ID) {
		t.Fatalf("exact word did not rank first: %+v", res.Hits)
	}
}

func TestToolOutputIsNotIndexed(t *testing.T) {
	r := newRig(t)
	b, _ := json.Marshal([]map[string]any{{"type": "tool_result", "tool_use_id": "x", "content": "uniqueTokenInToolOutput"}})
	if _, err := r.db.AppendMessage(context.Background(), r.orch, "user", b); err != nil {
		t.Fatal(err)
	}
	if res := r.search("uniqueTokenInToolOutput"); len(res.Hits) != 0 {
		t.Fatalf("tool output was indexed: %+v", res)
	}
}

func TestSupersededFactIsMarkedAndRanksAfterTheCurrentOne(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	m1 := r.say("user", "the dev server runs on port 8790")
	task, _ := r.svc.OpenTask(ctx, "set up the dev server", m1.ID)
	if _, err := r.svc.ApplyDigest(ctx, task.ID, m1.ID, Digest{Facts: []DigestFact{{Text: "The dev server port is 8790"}}}); err != nil {
		t.Fatal(err)
	}
	m2 := r.say("user", "the port is 8791 now")
	if _, err := r.svc.ApplyDigest(ctx, task.ID, m2.ID, Digest{Facts: []DigestFact{{Text: "The dev server port is 8791", Supersedes: "The dev server port is 8790"}}}); err != nil {
		t.Fatal(err)
	}
	res := r.search("dev server port", func(p *SearchParams) { p.In = []string{"facts"} })
	if len(res.Hits) != 2 || res.Hits[0].Superseded || !res.Hits[1].Superseded ||
		!strings.Contains(res.Hits[0].Snippet, "8791") || !strings.Contains(res.Hits[1].Snippet, "8790") {
		t.Fatalf("hits = %+v", res.Hits)
	}
	if res.Hits[0].MessageID != m2.ID || res.Hits[1].MessageID != m1.ID {
		t.Fatalf("facts do not point at their messages: %+v", res.Hits)
	}
	got, _ := r.db.Task(ctx, task.ID)
	if got.Facts[0].SupersededBy != "f2" || got.Facts[0].Text != "The dev server port is 8790" || got.Facts[0].Date == "" {
		t.Fatalf("facts = %+v", got.Facts)
	}
}

func TestDateFilter(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	for i, d := range []string{"2026-10-03T10:00:00.000Z", "2026-10-20T10:00:00.000Z", "2026-11-05T10:00:00.000Z"} {
		if err := r.db.Exec_(ctx, `INSERT INTO messages (agent_id, role, content_json, created_at) VALUES (?, 'user', ?, ?)`, r.orch,
			fmt.Sprintf(`[{"type":"text","text":"decision number %d about caching"}]`, i), d); err != nil {
			t.Fatal(err)
		}
	}
	// the helper above does not index: backfill like a migration does
	if err := r.db.BackfillForTest(ctx); err != nil {
		t.Fatal(err)
	}
	all := r.search("caching")
	if len(all.Hits) != 3 {
		t.Fatalf("all = %+v", all)
	}
	oct := r.search("caching", func(p *SearchParams) { p.After, p.Before = "2026-10-01", "2026-11-01" })
	if len(oct.Hits) != 2 {
		t.Fatalf("october = %+v", oct)
	}
	for _, h := range oct.Hits {
		if !strings.HasPrefix(h.Date, "2026-10") {
			t.Errorf("date outside the filter: %s", h.Date)
		}
	}
	if none := r.search("caching", func(p *SearchParams) { p.After = "2027-01-01" }); len(none.Hits) != 0 || none.Message != NothingMatches {
		t.Fatalf("none = %+v", none)
	}
}

func TestDigestNeverRewritesWhatTheOrchestratorOrUserWrote(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	m := r.say("user", `Use port 8791 and run "make test" before finishing`)
	task, _ := r.svc.OpenTask(ctx, `Use port 8791 and run "make test" before finishing`, m.ID)
	goal, outcome := "Run the service on 8791", "Done by the orchestrator"
	if _, err := r.svc.UpdateTask(ctx, UpdateInput{Goal: &goal, Outcome: &outcome, AddConstraints: []string{"never touch prod"},
		AddQuotes: []string{`run "make test"`}}, Turn{TaskID: task.ID, MessageID: m.ID}); err != nil {
		t.Fatal(err)
	}
	got, err := r.svc.ApplyDigest(ctx, task.ID, m.ID, Digest{
		Goal: "Something else entirely", Outcome: "digest outcome", Constraints: []string{"never touch prod", "second constraint"},
		Quotes: []string{`run "make test"`, "a paraphrase the user never wrote", "port 8791"}, Decisions: []string{"decided by digest"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.Goal != goal || got.GoalBy != "orchestrator" || got.Outcome != outcome {
		t.Fatalf("goal/outcome rewritten: %+v", got)
	}
	if len(got.Constraints) != 2 || got.Constraints[0] != "never touch prod" || got.Constraints[1] != "second constraint" {
		t.Fatalf("constraints = %v (existing kept, new added once)", got.Constraints)
	}
	var quotes []string
	for _, q := range got.Quotes {
		quotes = append(quotes, q.Text)
		if q.MessageID != m.ID {
			t.Errorf("quote without its message: %+v", q)
		}
	}
	if strings.Join(quotes, "|") != `run "make test"|port 8791` {
		t.Fatalf("quotes = %v: only exact wording of the request is kept", quotes)
	}
	// The fallback goal is replaced by the digest while nobody wrote one.
	m2 := r.say("user", "second request about logging")
	t2, _ := r.svc.OpenTask(ctx, "second request about logging", m2.ID)
	if t2.Goal != "second request about logging" || t2.GoalBy != "harness" {
		t.Fatalf("fallback goal = %+v", t2)
	}
	d2, _ := r.svc.ApplyDigest(ctx, t2.ID, m2.ID, Digest{Goal: "Add structured logging"})
	if d2.Goal != "Add structured logging" || d2.GoalBy != "digest" {
		t.Fatalf("digest goal = %+v", d2)
	}
}

func TestSecretNeverReachesRecordsFactsFilesIndexOrSnippets(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	m := r.say("user", "key is "+secretValue)
	task, _ := r.svc.OpenTask(ctx, "use key "+secretValue+" for the api", m.ID)
	title := "Task with " + secretValue
	if _, err := r.svc.UpdateTask(ctx, UpdateInput{Title: &title, Goal: &title, AddDecisions: []string{"store " + secretValue}, Files: []string{secretValue + ".txt"}},
		Turn{TaskID: task.ID, MessageID: m.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.svc.ApplyDigest(ctx, task.ID, m.ID, Digest{Facts: []DigestFact{{Text: "The API key is " + secretValue}}, Decisions: []string{secretValue}}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.svc.Command(ctx, ToolInput{Command: "create", Path: "keys.md", FileText: "token: " + secretValue, Summary: "holds " + secretValue}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.svc.WriteFile(ctx, "user.md", "from the user "+secretValue, "s"); err != nil {
		t.Fatal(err)
	}
	var all strings.Builder
	tasks, _ := r.svc.Tasks(ctx)
	b, _ := json.Marshal(tasks)
	all.Write(b)
	files, idx, _ := r.svc.Files(ctx)
	b, _ = json.Marshal(files)
	all.Write(b)
	all.WriteString(idx)
	for _, f := range []string{"keys.md", "user.md"} {
		pf, _ := r.svc.ReadFile(ctx, f)
		all.WriteString(pf.Content)
	}
	view, _ := r.svc.Command(ctx, ToolInput{Command: "view", Path: "keys.md"})
	all.WriteString(view)
	for _, q := range []string{"key", "secret", "api", "token", secretValue, "use"} {
		res := r.search(q)
		b, _ := json.Marshal(res)
		all.Write(b)
	}
	// And the raw index tables.
	for _, tbl := range []string{"search_docs", "search_u", "search_t"} {
		dump, err := r.db.DumpForTest(ctx, tbl)
		if err != nil {
			t.Fatal(err)
		}
		all.WriteString(dump)
	}
	if strings.Contains(all.String(), secretValue) {
		i := strings.Index(all.String(), secretValue)
		t.Fatalf("the secret reached memory: …%s…", all.String()[max(i-80, 0):min(i+80, all.Len())])
	}
}

func TestFilesCommandsAndLimits(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	run := func(in ToolInput) (string, error) { return r.svc.Command(ctx, in) }
	if _, err := run(ToolInput{Command: "create", Path: "/memories/arch/decisions.md", FileText: "# Decisions\nuse sqlite\nno orm\n", Summary: "architecture decisions"}); err != nil {
		t.Fatal(err)
	}
	if _, err := run(ToolInput{Command: "create", Path: "arch/decisions.md", FileText: "x", Summary: "s"}); err == nil {
		t.Fatal("create over an existing file must fail")
	}
	if _, err := run(ToolInput{Command: "create", Path: "nosummary.md", FileText: "x"}); err == nil || !strings.Contains(err.Error(), "summary") {
		t.Fatalf("a summary is required: %v", err)
	}
	v, err := run(ToolInput{Command: "view", Path: "arch/decisions.md"})
	if err != nil || !strings.Contains(v, "     2\tuse sqlite") {
		t.Fatalf("view: %q %v", v, err)
	}
	if v, _ := run(ToolInput{Command: "view", Path: "arch/decisions.md", ViewRange: []int{2, 2}}); strings.Contains(v, "# Decisions") || !strings.Contains(v, "use sqlite") {
		t.Fatalf("view_range: %q", v)
	}
	if _, err := run(ToolInput{Command: "str_replace", Path: "arch/decisions.md", OldStr: "no orm", NewStr: "no orm, plain SQL"}); err != nil {
		t.Fatal(err)
	}
	if _, err := run(ToolInput{Command: "str_replace", Path: "arch/decisions.md", OldStr: "missing", NewStr: "x"}); err == nil {
		t.Fatal("a missing old_str must fail")
	}
	if _, err := run(ToolInput{Command: "insert", Path: "arch/decisions.md", InsertLine: ptr(1), InsertText: "inserted line"}); err != nil {
		t.Fatal(err)
	}
	f, _ := r.svc.ReadFile(ctx, "arch/decisions.md")
	if f.Content != "# Decisions\ninserted line\nuse sqlite\nno orm, plain SQL\n" && f.Content != "# Decisions\ninserted line\nuse sqlite\nno orm, plain SQL" {
		t.Fatalf("content = %q", f.Content)
	}
	idx, _ := run(ToolInput{Command: "view", Path: "/memories"})
	if !strings.Contains(idx, "arch/decisions.md: architecture decisions") {
		t.Fatalf("index = %q", idx)
	}
	if _, err := run(ToolInput{Command: "rename", OldPath: "arch/decisions.md", NewPath: "decisions.md"}); err != nil {
		t.Fatal(err)
	}
	// Traversal, hidden, wrong type, the generated index, size and count limits.
	for _, p := range []string{"../x.md", "a/../../x.md", "/etc/passwd", ".hidden.md", "a//b.md", "notes.txt", "INDEX.md", strings.Repeat("x", 90) + ".md", "a\\b.md"} {
		if _, err := run(ToolInput{Command: "create", Path: p, FileText: "x", Summary: "s"}); err == nil {
			t.Errorf("path %q was accepted", p)
		}
	}
	if _, err := run(ToolInput{Command: "create", Path: "big.md", FileText: strings.Repeat("x", MaxFileBytes+1), Summary: "s"}); err == nil {
		t.Error("an oversized file was accepted")
	}
	for i := 0; i < MaxFiles; i++ {
		if err := r.db.PutFileForTest(ctx, fmt.Sprintf("f%d.md", i)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := run(ToolInput{Command: "create", Path: "onetoomany.md", FileText: "x", Summary: "s"}); err == nil {
		t.Error("the 501st file was accepted")
	}
	// Deleting a file removes it from the index.
	if res := r.search("sqlite"); len(res.Hits) == 0 {
		t.Fatal("the file is not searchable")
	}
	if _, err := run(ToolInput{Command: "delete", Path: "decisions.md"}); err != nil {
		t.Fatal(err)
	}
	if res := r.search("sqlite"); len(res.Hits) != 0 {
		t.Fatalf("a deleted file is still in the index: %+v", res)
	}
	if len(r.events) == 0 {
		t.Fatal("no memory.updated events")
	}
}

func ptr(n int) *int { return &n }

func TestTaskUpdateLimitsAttachAndQuotes(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	m1 := r.say("user", "first request")
	t1, _ := r.svc.OpenTask(ctx, "first request", m1.ID)
	if !t1.Auto {
		t.Fatal("the harness-opened record is auto")
	}
	m2 := r.say("user", "follow up on the same work")
	t2, _ := r.svc.OpenTask(ctx, "follow up on the same work", m2.ID)
	// The orchestrator says message 2 belongs to task 1: it is attached, the auto record dropped.
	done := "done"
	got, err := r.svc.UpdateTask(ctx, UpdateInput{ID: t1.ID, Status: &done}, Turn{TaskID: t2.ID, MessageID: m2.ID})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.MessageIDs) != 2 || got.Status != "done" || got.Auto {
		t.Fatalf("task = %+v", got)
	}
	if _, err := r.db.Task(ctx, t2.ID); err == nil {
		t.Fatal("the auto record of the attached message was not dropped")
	}
	bad := "paused"
	if _, err := r.svc.UpdateTask(ctx, UpdateInput{ID: t1.ID, Status: &bad}, Turn{}); err == nil {
		t.Fatal("a bad status was accepted")
	}
	if _, err := r.svc.UpdateTask(ctx, UpdateInput{ID: "tsk_nope"}, Turn{}); err == nil {
		t.Fatal("an unknown task was accepted")
	}
	if _, err := r.svc.UpdateTask(ctx, UpdateInput{ID: t1.ID, AddQuotes: []string{"words nobody said"}}, Turn{TaskID: t1.ID, MessageID: m1.ID}); err == nil {
		t.Fatal("a quote that is not in the request was accepted")
	}
	many := make([]string, MaxItems+1)
	for i := range many {
		many[i] = fmt.Sprint("c", i)
	}
	if _, err := r.svc.UpdateTask(ctx, UpdateInput{ID: t1.ID, AddConstraints: many}, Turn{}); err == nil {
		t.Fatal("more than the list limit was accepted")
	}
}

func TestRecallIsByteExactAndCapped(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	text := "Точный текст: \"кавычки\", <tags>, tab\there,\nнеколько строк & ещё — 100%"
	m := r.say("user", text)
	got, err := r.svc.Recall(ctx, m.ID)
	if err != nil || got.Text != text || got.Truncated || got.Role != "user" {
		t.Fatalf("recall = %+v %v", got, err)
	}
	long := strings.Repeat("я", MaxRecall) // 2 bytes each
	m2 := r.say("assistant", long)
	got, err = r.svc.Recall(ctx, m2.ID)
	if err != nil || !got.Truncated || len(got.Text) > MaxRecall || !strings.HasPrefix(long, got.Text) {
		t.Fatalf("recall of a long message: len=%d truncated=%v %v", len(got.Text), got.Truncated, err)
	}
	if _, err := r.svc.Recall(ctx, 99999); err == nil {
		t.Fatal("an unknown message was recalled")
	}
}

func TestSearchFindsADetailInA300TurnHistory(t *testing.T) {
	r := newRig(t)
	for i := 1; i <= 300; i++ {
		text := fmt.Sprintf("turn %d: we looked at module m%d and nothing special happened", i, i)
		if i == 142 {
			text = "turn 142: the staging database password rotates every Tuesday at 09:30 UTC"
		}
		r.say("user", text)
		r.say("assistant", fmt.Sprintf("noted turn %d", i))
	}
	res := r.search("staging database rotates Tuesday")
	if len(res.Hits) == 0 || !strings.Contains(res.Hits[0].Snippet, "turn 142") {
		t.Fatalf("hits = %+v", res.Hits)
	}
	if len(res.Hits) > projectstore.MaxHits {
		t.Fatalf("%d hits", len(res.Hits))
	}
	for _, h := range res.Hits {
		if len([]rune(h.Snippet)) > SnippetLen+2 {
			t.Errorf("snippet of %d runes", len([]rune(h.Snippet)))
		}
	}
	if gone := r.search("hovercraft"); len(gone.Hits) != 0 || gone.Message != NothingMatches {
		t.Fatalf("gone = %+v", gone)
	}
}

// A later request can contradict a fact recorded under an earlier task.
func TestFactIsSupersededAcrossTasks(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	m1 := r.say("user", "port is 8790")
	t1, _ := r.svc.OpenTask(ctx, "port is 8790", m1.ID)
	_, _ = r.svc.ApplyDigest(ctx, t1.ID, m1.ID, Digest{Facts: []DigestFact{{Text: "The dev server port is 8790"}}})
	m2 := r.say("user", "port is 8791 now")
	t2, _ := r.svc.OpenTask(ctx, "port is 8791 now", m2.ID)
	if k := r.svc.KnownFacts(ctx, t2.ID, 10); len(k) != 1 || k[0] != "The dev server port is 8790" {
		t.Fatalf("known facts = %v", k)
	}
	_, _ = r.svc.ApplyDigest(ctx, t2.ID, m2.ID, Digest{Facts: []DigestFact{{Text: "The dev server port is 8791", Supersedes: "The dev server port is 8790"}}})
	old, _ := r.db.Task(ctx, t1.ID)
	if old.Facts[0].SupersededBy != t2.ID+"/f1" || old.Facts[0].Text != "The dev server port is 8790" {
		t.Fatalf("old fact = %+v", old.Facts[0])
	}
	res := r.search("dev server port", func(p *SearchParams) { p.In = []string{"facts"} })
	if len(res.Hits) != 2 || res.Hits[0].Superseded || !res.Hits[1].Superseded {
		t.Fatalf("hits = %+v", res.Hits)
	}
}
