package memory

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

func TestRememberStoresADatedFactWithItsSource(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	req := r.say("user", "please look at the build")
	task, err := r.db.CreateTask(ctx, projectstore.Task{Title: "build", Auto: true})
	if err != nil {
		t.Fatal(err)
	}
	f, taskID, err := r.svc.Remember(ctx, RememberInput{Text: "The build needs Go 1.26", Kind: "constraint-ish", By: "agt_1", TaskID: task.ID, MessageID: req.ID})
	if err == nil || f.ID != "" {
		t.Fatalf("an unknown kind is refused: %+v %v", f, err)
	}
	f, taskID, err = r.svc.Remember(ctx, RememberInput{Text: "The build needs Go 1.26 " + secretValue, Kind: "fact", About: "toolchain", By: "agt_1", TaskID: task.ID, MessageID: req.ID})
	if err != nil || taskID != task.ID {
		t.Fatalf("remember = %+v %q %v", f, taskID, err)
	}
	if f.Date == "" || f.MessageID != req.ID || f.Kind != "fact" || f.About != "toolchain" || f.RememberedBy != "agt_1" || f.Text != "The build needs Go 1.26 [secret]" {
		t.Fatalf("fact = %+v", f)
	}
	got, _ := r.db.Task(ctx, task.ID)
	if got.Auto || len(got.Facts) != 1 {
		t.Fatalf("the record is kept and holds the fact: %+v", got)
	}
	if !slices.Contains(r.events, "fact.remembered") || !slices.Contains(r.events, "task.updated") {
		t.Fatalf("events = %v", r.events)
	}
	if res := r.search("Go 1.26"); len(res.Hits) == 0 {
		t.Fatalf("the fact is searchable: %+v", res)
	}
	// The same text again is not stored twice.
	if g, _, err := r.svc.Remember(ctx, RememberInput{Text: "the build needs  go 1.26 [secret]", Kind: "fact", TaskID: task.ID}); err != nil || g.ID != f.ID {
		t.Fatalf("duplicate = %+v %v", g, err)
	}
}

func TestRememberSupersedesAndForgetRestores(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	a, _, err := r.svc.Remember(ctx, RememberInput{Text: "tests run with make test", Kind: "decision", About: "test command", By: "user"})
	if err != nil {
		t.Fatal(err)
	}
	b, taskID, err := r.svc.Remember(ctx, RememberInput{Text: "tests run with go test ./...", Kind: "decision", About: "Test command", By: "user"})
	if err != nil {
		t.Fatal(err)
	}
	tasks, _ := r.db.Tasks(ctx)
	if len(tasks) != 1 || tasks[0].Title != RememberedTaskTitle {
		t.Fatalf("items outside a turn go to the Remembered record: %+v", tasks)
	}
	facts := tasks[0].Facts
	if len(facts) != 2 || facts[0].SupersededBy != b.ID || facts[1].SupersededBy != "" {
		t.Fatalf("facts = %+v", facts)
	}
	if err := r.svc.Forget(ctx, taskID, b.ID); err != nil {
		t.Fatal(err)
	}
	got, _ := r.db.Task(ctx, taskID)
	if len(got.Facts) != 1 || got.Facts[0].ID != a.ID || got.Facts[0].SupersededBy != "" {
		t.Fatalf("after undo: %+v", got.Facts)
	}
	if err := r.svc.Forget(ctx, taskID, b.ID); !errors.Is(err, projectstore.ErrNotFound) {
		t.Fatalf("second forget = %v", err)
	}
	// A new item after a deletion never reuses an id.
	c, _, _ := r.svc.Remember(ctx, RememberInput{Text: "another", Kind: "todo"})
	if c.ID == a.ID {
		t.Fatalf("id reused: %+v", c)
	}
}
