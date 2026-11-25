package projectstore

import (
	"context"
	"errors"
	"testing"
)

func TestPlansAndManualCompaction(t *testing.T) {
	ctx := context.Background()
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	db, err := s.Create(ctx, NewProject{Name: "p", ModelsJSON: "{}", MaxDepth: 1, OrchestratorModel: "m", Mode: ModePlan})
	if err != nil {
		t.Fatal(err)
	}
	if info, _ := db.Info(ctx); info.Mode != ModePlan {
		t.Fatalf("mode = %q", info.Mode)
	}
	if _, err := db.LatestPlan(ctx); !errors.Is(err, ErrNotFound) {
		t.Fatalf("no plan yet: %v", err)
	}
	p1, _ := db.AddPlan(ctx, 5, "first")
	p2, _ := db.AddPlan(ctx, 9, "second")
	if got, _ := db.LatestPlan(ctx); got.ID != p2.ID || got.Status != PlanPending {
		t.Fatalf("latest = %+v", got)
	}
	if got, err := db.ApprovePlan(ctx, p1.ID); err != nil || got.Status != PlanApproved || got.ApprovedAt == nil {
		t.Fatalf("approve = %+v %v", got, err)
	}
	if _, err := db.ApprovePlan(ctx, p1.ID); !errors.Is(err, ErrPlanNotPending) {
		t.Fatalf("second approve: %v", err)
	}
	if _, err := db.ApprovePlan(ctx, "pln_nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown: %v", err)
	}
	orch, _ := db.Orchestrator(ctx)
	c, err := db.AddManualCompaction(ctx, orch.ID, "sum", 7)
	if err != nil || !c.Manual {
		t.Fatalf("%+v %v", c, err)
	}
	list, _ := db.Compactions(ctx, orch.ID)
	if len(list) != 1 || !list[0].Manual || list[0].MessageCount != 7 {
		t.Fatalf("compactions = %+v", list)
	}
}

func TestRewindHidesButKeepsAndDropsTheCutTurnsRecords(t *testing.T) {
	ctx := context.Background()
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	db, err := s.Create(ctx, NewProject{Name: "p", ModelsJSON: "{}", MaxDepth: 2, OrchestratorModel: "m"})
	if err != nil {
		t.Fatal(err)
	}
	orch, _ := db.Orchestrator(ctx)
	add := func(agent, role, text string) Message {
		m, err := db.AppendMessage(ctx, agent, role, []byte(`[{"type":"text","text":"`+text+`"}]`))
		if err != nil {
			t.Fatal(err)
		}
		return m
	}
	u1 := add(orch.ID, "user", "first request alpha")
	add(orch.ID, "assistant", "first answer")
	u2 := add(orch.ID, "user", "second request bravo")
	parent := orch.ID
	child, err := db.CreateAgent(ctx, NewAgent{ParentID: &parent, Depth: 1, Role: "w", Title: "t", Task: "x", Model: "m", Status: StatusCompleted})
	if err != nil {
		t.Fatal(err)
	}
	add(child.ID, "user", "child task")
	add(orch.ID, "assistant", "second answer")
	t1, _ := db.CreateTask(ctx, Task{Title: "one", Status: TaskDone, Goal: "g1", MessageIDs: []int64{u1.ID}})
	t2, _ := db.CreateTask(ctx, Task{Title: "two", Status: TaskOpen, Goal: "g2", MessageIDs: []int64{u2.ID},
		Facts: []Fact{{ID: "f1", Text: "fact", Date: Now(), MessageID: u2.ID}}})
	t3, _ := db.CreateTask(ctx, Task{Title: "span", Status: TaskOpen, Goal: "g3", MessageIDs: []int64{u1.ID, u2.ID},
		Quotes: []Quote{{Text: "q", MessageID: u2.ID}}, Facts: []Fact{{ID: "f2", Text: "late", Date: Now(), MessageID: u2.ID}}})
	if err := db.SaveReceipt(ctx, u2.ID, "full", "{}"); err != nil {
		t.Fatal(err)
	}
	if err := db.SaveReceipt(ctx, u1.ID, "full", "{}"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.AddPlan(ctx, u2.ID, "plan"); err != nil {
		t.Fatal(err)
	}

	res, err := db.Rewind(ctx, u2.ID)
	if err != nil {
		t.Fatal(err)
	}
	if res.MessagesCut != 3 || res.AgentsCut != 1 || res.TasksDropped != 1 {
		t.Fatalf("result = %+v", res)
	}
	msgs, _ := db.Messages(ctx, orch.ID)
	if len(msgs) != 2 || msgs[1].Role != "assistant" {
		t.Fatalf("visible messages = %+v", msgs)
	}
	if m, _ := db.Messages(ctx, child.ID); len(m) != 0 {
		t.Fatalf("the cut sub-agent's messages are visible: %+v", m)
	}
	if ags, _ := db.Agents(ctx); len(ags) != 1 {
		t.Fatalf("agents = %d, the cut sub-agent must be hidden", len(ags))
	}
	var n int
	if err := db.sql.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages WHERE rewound_at IS NOT NULL`).Scan(&n); err != nil || n != 3 {
		t.Fatalf("rewound rows on disk = %d %v", n, err)
	}
	if _, err := db.Task(ctx, t2.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("the task of the cut turn survived: %v", err)
	}
	if _, err := db.Task(ctx, t1.ID); err != nil {
		t.Fatalf("an older task was dropped: %v", err)
	}
	got3, _ := db.Task(ctx, t3.ID)
	if len(got3.MessageIDs) != 1 || len(got3.Quotes) != 0 || len(got3.Facts) != 0 {
		t.Fatalf("a task that spans the cut keeps what is before it: %+v", got3)
	}
	if _, err := db.Receipt(ctx, u2.ID); err == nil {
		t.Fatal("the cut turn's receipt survived")
	}
	if _, err := db.Receipt(ctx, u1.ID); err != nil {
		t.Fatalf("the earlier receipt was dropped: %v", err)
	}
	if _, err := db.LatestPlan(ctx); !errors.Is(err, ErrNotFound) {
		t.Fatal("a plan of the cut turn survived")
	}
	if hits, _ := db.Search(ctx, SearchQuery{Text: "bravo", Kinds: []string{DocMessage}}); len(hits) != 0 {
		t.Fatalf("a rewound request is still found: %+v", hits)
	}
	if hits, _ := db.Search(ctx, SearchQuery{Text: "alpha", Kinds: []string{DocMessage}}); len(hits) != 1 {
		t.Fatalf("the kept request is not found: %+v", hits)
	}
	if _, err := db.Rewind(ctx, 99999); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown message: %v", err)
	}
}
