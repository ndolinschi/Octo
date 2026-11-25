package orchestrator_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/notemd"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

const m5Secret = "BODYONLY-"

// seedNotes creates n notes whose bodies hold a marker that only a read may show.
func (r *rig) seedNotes(t *testing.T, pid string, n int) []projectstore.Note {
	t.Helper()
	var out []projectstore.Note
	for i := 0; i < n; i++ {
		note, err := r.notes.CreateNote(context.Background(), pid, project.NoteInput{
			Title:       fmt.Sprintf("Topic %03d", i),
			Description: fmt.Sprintf("How topic %03d works and when it matters for the release plan", i),
			Tags:        []string{"area-" + fmt.Sprint(i%5)},
			Content:     fmt.Sprintf("%s%03d\n%s", m5Secret, i, strings.Repeat("a long body line that must stay out of the prompt\n", 40)),
		})
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, note)
	}
	return out
}

func TestM5PromptHasAnIndexOfDescriptionsWithinTheBudgetAndNoBodies(t *testing.T) {
	m := &modeLLM{answer: "ok"}
	r := newRig(t, m.handler())
	pid := r.project(t, 1)
	notes := r.seedNotes(t, pid, 100)
	// Read the oldest note: it moves to the top of the index.
	if _, err := r.notes.Read(context.Background(), pid, notes[0].ID); err != nil {
		t.Fatal(err)
	}
	// The context report (before any turn: estimated from what the request holds) counts the index, not the bodies.
	rep, err := r.orch.Context(context.Background(), pid, "")
	if err != nil {
		t.Fatal(err)
	}
	var catTokens int64
	for _, c := range rep.Categories {
		if c.ID == "notes" {
			catTokens = c.Tokens
		}
	}
	if catTokens < 1000 || catTokens > notemd.IndexBudget+200 {
		t.Fatalf("notes category = %d tokens, categories %+v", catTokens, rep.Categories)
	}
	if st := r.run(t, pid, "hello", nil); st != "completed" {
		t.Fatal(st)
	}
	sys := m.systems[0]
	if strings.Contains(sys, m5Secret) || strings.Contains(sys, "a long body line") {
		t.Fatal("a note body is in the system prompt")
	}
	_, after, ok := strings.Cut(sys, "Index of 100 notes")
	if !ok {
		t.Fatalf("no index in the prompt:\n%s", sys)
	}
	lines := strings.Split(strings.TrimSpace(after[strings.Index(after, "\n")+1:]), "\n")
	if !strings.HasPrefix(lines[0], notes[0].ID+" · Topic 000 — How topic 000 works") || !strings.HasSuffix(lines[0], "[area-0]") {
		t.Fatalf("the note just read is not first: %q", lines[0])
	}
	// Then the newest first.
	if !strings.HasPrefix(lines[1], notes[99].ID+" · Topic 099") {
		t.Fatalf("second line: %q", lines[1])
	}
	last := lines[len(lines)-1]
	var more int
	if _, err := fmt.Sscanf(last, "%d more notes — use search_notes", &more); err != nil || more == 0 || more != 100-(len(lines)-1) {
		t.Fatalf("last line %q (%d index lines)", last, len(lines))
	}
	var tokens int64
	for _, l := range lines {
		tokens += projectstore.EstimateTokens(len(l) + 1)
	}
	if tokens > notemd.IndexBudget {
		t.Fatalf("the index is %d tokens, budget %d", tokens, notemd.IndexBudget)
	}
}

func TestM5PinnedNotesAreInTheirWholeAndLimited(t *testing.T) {
	m := &modeLLM{answer: "ok"}
	r := newRig(t, m.handler())
	pid := r.project(t, 1)
	ctx := context.Background()
	rule, err := r.notes.CreateNote(ctx, pid, project.NoteInput{Title: "Always", Description: "Rules", Content: "Never touch the vendor directory.", Pinned: true})
	if err != nil {
		t.Fatal(err)
	}
	r.seedNotes(t, pid, 3)
	if st := r.run(t, pid, "hello", nil); st != "completed" {
		t.Fatal(st)
	}
	sys := m.systems[0]
	if !strings.Contains(sys, "Pinned notes (rules that always apply):\n### Always\nNever touch the vendor directory.") {
		t.Fatalf("pinned note not whole:\n%s", sys)
	}
	if strings.Index(sys, rule.ID+" · Always") < 0 || strings.Index(sys, rule.ID+" · Always") > strings.Index(sys, "Topic 000") {
		t.Fatal("the pinned note is not first in the index")
	}
	// Limits: three notes, 2 000 characters together; refusals are 400s that say why.
	pin := true
	for i := 0; i < 2; i++ {
		n, err := r.notes.CreateNote(ctx, pid, project.NoteInput{Title: fmt.Sprint("pin", i), Content: "x", Pinned: true})
		if err != nil {
			t.Fatal(err)
		}
		_ = n
	}
	if _, err := r.notes.CreateNote(ctx, pid, project.NoteInput{Title: "fourth", Content: "x", Pinned: true}); err == nil || !strings.Contains(err.Error(), "at most 3 notes can be pinned") {
		t.Fatalf("fourth pin: %v", err)
	}
	all, _ := r.notes.List(ctx, pid)
	var plain projectstore.Note
	for _, n := range all {
		if !n.Pinned {
			plain = n
			break
		}
	}
	if _, err := r.notes.Patch(ctx, pid, plain.ID, project.NotePatch{Pinned: &pin}); err == nil || !strings.Contains(err.Error(), "at most 3") {
		t.Fatalf("pin by update: %v", err)
	}
	big := strings.Repeat("я", 2001)
	if _, err := r.notes.Patch(ctx, pid, rule.ID, project.NotePatch{Content: &big}); err == nil || !strings.Contains(err.Error(), "2000 characters") {
		t.Fatalf("a pinned body over the limit: %v", err)
	}
	var pe *project.Error
	_, err = r.notes.CreateNote(ctx, pid, project.NoteInput{Title: "fifth", Content: "x", Pinned: true})
	if !asProjectError(err, &pe) || pe.Kind != project.KindInvalid {
		t.Fatalf("not a 400: %v", err)
	}
}

func asProjectError(err error, target **project.Error) bool {
	pe, ok := err.(*project.Error)
	if ok {
		*target = pe
	}
	return ok
}

func TestM5ToolsReadSearchAndWrite(t *testing.T) {
	m := &modeLLM{answer: "ok"}
	r := newRig(t, m.handler())
	pid := r.project(t, 1)
	ctx := context.Background()
	budget, err := r.notes.CreateNote(ctx, pid, project.NoteInput{Title: "Бюджет", Description: "Лимиты расходов на месяц", Content: "Лимит бюджета на месяц: 500 долларов."})
	if err != nil {
		t.Fatal(err)
	}
	other, err := r.notes.CreateNote(ctx, pid, project.NoteInput{Title: "Deploy", Description: "How to deploy", Content: "Run the deploy script."})
	if err != nil {
		t.Fatal(err)
	}
	m.calls = [][2]string{
		{"read_note", `{"id":"` + budget.ID + `"}`},
		{"search_notes", `{"query":"бюджета"}`},
		{"search_notes", `{"query":"zzzqqq"}`},
		{"read_note", `{"id":"nte_missing"}`},
		{"write_note", `{"title":"Release","description":"When the release ships","body":"Friday.","tags":["plan"]}`},
		{"write_note", `{"id":"` + other.ID + `","title":"Deploy","description":"","body":"x"}`},
		{"write_note", `{"title":"Deploy","description":"dup","body":"x"}`},
	}
	if st := r.run(t, pid, "go", nil); st != "completed" {
		t.Fatal(st)
	}
	res := m.results
	if len(res) != 7 {
		t.Fatalf("%d results: %q", len(res), res)
	}
	if res[0] != budget.Content {
		t.Errorf("read_note = %q", res[0])
	}
	var found struct {
		Hits []struct{ ID, Title, Description, Snippet string }
	}
	if err := json.Unmarshal([]byte(res[1]), &found); err != nil || len(found.Hits) != 1 || found.Hits[0].ID != budget.ID ||
		found.Hits[0].Description != "Лимиты расходов на месяц" || !strings.Contains(found.Hits[0].Snippet, "500 долларов") {
		t.Errorf("Russian search = %s (%v)", res[1], err)
	}
	if !strings.Contains(res[2], `"hits":[]`) || !strings.Contains(res[2], "No note matches") {
		t.Errorf("empty search = %s", res[2])
	}
	if !strings.Contains(res[3], "note not found") {
		t.Errorf("missing note = %q", res[3])
	}
	if !strings.HasPrefix(res[4], "created note nte_") {
		t.Errorf("write_note create = %q", res[4])
	}
	if !strings.Contains(res[5], "description is required") || !strings.Contains(res[6], "exists") {
		t.Errorf("write_note refusals = %q / %q", res[5], res[6])
	}
	// The read was recorded; the new note carries the description and tags given.
	read, _ := r.notes.Get(ctx, pid, budget.ID)
	if read.ReadCount != 1 || read.LastReadAt == "" {
		t.Errorf("read not recorded: %+v", read)
	}
	hits, err := r.notes.Search(ctx, pid, "release", 5)
	if err != nil || len(hits) != 1 || hits[0].Description != "When the release ships" || hits[0].Tags[0] != "plan" || hits[0].Author != projectstore.AuthorOrchestrator || hits[0].DescriptionAuto {
		t.Errorf("written note = %+v %v", hits, err)
	}
}

func TestM5WriteNoteIsRefusedInReadOnlyModes(t *testing.T) {
	m := &modeLLM{answer: "ok", calls: [][2]string{
		{"write_note", `{"title":"X","description":"d","body":"b"}`},
		{"search_notes", `{"query":"deploy"}`},
	}}
	r := newRig(t, m.handler())
	pid, _ := r.projectWith(t, project.Input{Mode: sp("plan")})
	if _, err := r.notes.CreateNote(context.Background(), pid, project.NoteInput{Title: "Deploy", Description: "How to deploy", Content: "script"}); err != nil {
		t.Fatal(err)
	}
	if st := r.run(t, pid, "go", nil); st != "completed" {
		t.Fatal(st)
	}
	if len(m.results) != 2 || !strings.HasPrefix(m.results[0], "Refused:") || !strings.Contains(m.results[0], "writing notes") || !strings.Contains(m.results[1], "Deploy") {
		t.Fatalf("results = %q", m.results)
	}
	if all, _ := r.notes.List(context.Background(), pid); len(all) != 1 {
		t.Fatalf("a plan turn wrote a note: %d", len(all))
	}
}

func TestM5SubAgentsGetTheNoteTools(t *testing.T) {
	tr := &toolRun{}
	r := newRig(t, tr.llm("search_notes", map[string]any{"query": "deploy"}))
	pid := r.project(t, 2)
	if _, err := r.notes.CreateNote(context.Background(), pid, project.NoteInput{Title: "Deploy", Description: "How to deploy", Content: "script"}); err != nil {
		t.Fatal(err)
	}
	if st := r.run(t, pid, "go", nil); st != "completed" {
		t.Fatal(st)
	}
	for who, names := range map[string][]string{"orchestrator": tr.orchTools, "sub-agent": tr.subTools} {
		for _, want := range []string{"read_note", "search_notes", "write_note"} {
			if !has(names, want) {
				t.Errorf("%s lacks %s: %v", who, want, names)
			}
		}
	}
	if !strings.Contains(tr.result, "How to deploy") {
		t.Errorf("sub-agent search result = %q", tr.result)
	}
}
