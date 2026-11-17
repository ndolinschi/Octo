package projectstore

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func newStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func create(t *testing.T, s *Store, name string, folders ...Folder) *DB {
	t.Helper()
	db, err := s.Create(context.Background(), NewProject{
		Name: name, Description: "d", ModelsJSON: `{}`, MaxDepth: 3, Folders: folders,
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	return db
}

func TestProjectLifecycle(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	db := create(t, s, "alpha", Folder{Label: "a", Path: "/tmp/a"})

	info, err := db.Info(ctx)
	if err != nil || info.Name != "alpha" || info.MaxDepth != 3 {
		t.Fatalf("Info = %+v, %v", info, err)
	}
	orch, err := db.Orchestrator(ctx)
	if err != nil || orch.Role != OrchestratorRole || orch.Status != StatusIdle || orch.ParentID != nil {
		t.Fatalf("Orchestrator = %+v, %v", orch, err)
	}

	name := "beta"
	if err := db.UpdateInfo(ctx, InfoPatch{Name: &name}); err != nil {
		t.Fatal(err)
	}
	if err := s.Rename(ctx, db.ID(), name); err != nil {
		t.Fatal(err)
	}
	info, _ = db.Info(ctx)
	if info.Name != "beta" || info.Description != "d" {
		t.Fatalf("patch touched other fields: %+v", info)
	}

	ids, err := s.IDs(ctx)
	if err != nil || len(ids) != 1 {
		t.Fatalf("IDs = %v, %v", ids, err)
	}
	if err := s.Delete(ctx, db.ID()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get(ctx, db.ID()); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get after delete = %v, want ErrNotFound", err)
	}
	if _, err := os.Stat(filepath.Join(s.dir, "projects", db.ID())); !os.IsNotExist(err) {
		t.Fatalf("project dir should be gone: %v", err)
	}
}

func TestReplaceFolders(t *testing.T) {
	ctx := context.Background()
	db := create(t, newStore(t), "p", Folder{Label: "a", Path: "/a"}, Folder{Label: "b", Path: "/b"})
	if err := db.ReplaceFolders(ctx, []Folder{{Label: "c", Path: "/c"}}); err != nil {
		t.Fatal(err)
	}
	got, _ := db.Folders(ctx)
	if len(got) != 1 || got[0].Label != "c" || got[0].ID == "" {
		t.Fatalf("Folders = %+v", got)
	}
	err := db.ReplaceFolders(ctx, []Folder{{Label: "x", Path: "/x"}, {Label: "x", Path: "/y"}})
	if err == nil {
		t.Fatal("duplicate label should fail")
	}
	got, _ = db.Folders(ctx)
	if len(got) != 1 || got[0].Label != "c" {
		t.Fatalf("failed replace must roll back, got %+v", got)
	}
}

func TestAgentsAndMessages(t *testing.T) {
	ctx := context.Background()
	db := create(t, newStore(t), "p")
	orch, _ := db.Orchestrator(ctx)
	tier, tu := TierFast, "toolu_1"
	child, err := db.CreateAgent(ctx, NewAgent{
		ParentID: &orch.ID, Depth: 1, Role: "Explorer", Title: "t", Task: "do", Model: "m",
		Tier: &tier, Status: StatusRunning, SpawnToolUseID: &tu, Started: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if child.Tier == nil || *child.Tier != TierFast || child.StartedAt == nil || *child.ParentID != orch.ID {
		t.Fatalf("child = %+v", child)
	}
	done, res := StatusCompleted, "report"
	fin := Now()
	if _, err := db.UpdateAgent(ctx, child.ID, AgentPatch{Status: &done, Result: &res, FinishedAt: &fin}); err != nil {
		t.Fatal(err)
	}
	child, _ = db.RecordUsage(ctx, UsageRecord{AgentID: child.ID, Model: "m", Source: SourceAPI, InputTokens: 10, OutputTokens: 5})
	if child.Status != StatusCompleted || *child.Result != "report" || child.InputTokens != 10 || child.OutputTokens != 5 {
		t.Fatalf("child after update = %+v", child)
	}
	agents, _ := db.Agents(ctx)
	if len(agents) != 2 || agents[0].ID != orch.ID {
		t.Fatalf("Agents order = %+v", agents)
	}

	raw, _ := json.Marshal([]map[string]any{
		{"type": "text", "text": ""},
		{"type": "text", "text": "hi"},
		{"type": "tool_use", "id": "t1", "name": "x", "input": map[string]any{"a": 1}},
		{"type": "tool_result", "tool_use_id": "t1", "content": []map[string]any{{"type": "text", "text": "out"}}, "is_error": true},
	})
	if _, err := db.AppendMessage(ctx, orch.ID, "assistant", raw); err != nil {
		t.Fatal(err)
	}
	msgs, _ := db.Messages(ctx, orch.ID)
	if len(msgs) != 1 || len(msgs[0].Content) != 3 {
		t.Fatalf("messages = %+v", msgs)
	}
	tr := msgs[0].Content[2]
	if tr.Type != "tool_result" || *tr.Content != "out" || !*tr.IsError {
		t.Fatalf("tool_result = %+v", tr)
	}
	if other, _ := db.Messages(ctx, child.ID); len(other) != 0 {
		t.Fatal("messages leaked across agents")
	}
}

func TestNotes(t *testing.T) {
	ctx := context.Background()
	db := create(t, newStore(t), "p")
	n, err := db.CreateNote(ctx, "Goal", "ship", AuthorUser)
	if err != nil {
		t.Fatal(err)
	}
	c := "ship fast"
	n2, err := db.UpdateNote(ctx, n.ID, nil, &c)
	if err != nil || n2.Content != c || n2.Title != "Goal" {
		t.Fatalf("UpdateNote = %+v, %v", n2, err)
	}
	if by, err := db.NoteByTitle(ctx, "Goal"); err != nil || by.ID != n.ID {
		t.Fatalf("NoteByTitle = %+v, %v", by, err)
	}
	if err := db.DeleteNote(ctx, n.ID); err != nil {
		t.Fatal(err)
	}
	if err := db.DeleteNote(ctx, n.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second delete = %v", err)
	}
}

func TestProjectsAreIsolated(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	a, b := create(t, s, "a"), create(t, s, "b")
	if _, err := a.CreateNote(ctx, "only-a", "x", AuthorUser); err != nil {
		t.Fatal(err)
	}
	if notes, _ := b.Notes(ctx); len(notes) != 0 {
		t.Fatalf("note leaked to project b: %+v", notes)
	}
	for _, id := range []string{a.ID(), b.ID()} {
		if _, err := os.Stat(filepath.Join(s.dir, "projects", id, "project.sqlite")); err != nil {
			t.Fatalf("missing per-project db: %v", err)
		}
	}
	if a.ID() == b.ID() {
		t.Fatal("ids collide")
	}
}

func TestRecoverInterrupted(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	db, err := s.Create(ctx, NewProject{Name: "p", ModelsJSON: `{}`, MaxDepth: 3})
	if err != nil {
		t.Fatal(err)
	}
	orch, _ := db.Orchestrator(ctx)
	running := StatusRunning
	if _, err := db.UpdateAgent(ctx, orch.ID, AgentPatch{Status: &running}); err != nil {
		t.Fatal(err)
	}
	child, _ := db.CreateAgent(ctx, NewAgent{ParentID: &orch.ID, Depth: 1, Role: "r", Model: "m", Status: StatusRunning})
	id := db.ID()
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	s2, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	db2, err := s2.Get(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if err := db2.RecoverInterrupted(ctx); err != nil {
		t.Fatal(err)
	}
	o, _ := db2.Orchestrator(ctx)
	c, _ := db2.Agent(ctx, child.ID)
	if o.Status != StatusIdle {
		t.Fatalf("orchestrator = %s, want idle", o.Status)
	}
	if c.Status != StatusFailed || c.Error == nil || *c.Error != "interrupted" || c.FinishedAt == nil {
		t.Fatalf("child = %+v", c)
	}
}

func TestConcurrentWrites(t *testing.T) {
	ctx := context.Background()
	db := create(t, newStore(t), "p")
	orch, _ := db.Orchestrator(ctx)
	var wg sync.WaitGroup
	errs := make(chan error, 40)
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			a, err := db.CreateAgent(ctx, NewAgent{ParentID: &orch.ID, Depth: 1, Role: "r", Model: "m", Status: StatusRunning})
			if err != nil {
				errs <- err
				return
			}
			for range 5 {
				if _, err := db.RecordUsage(ctx, UsageRecord{AgentID: a.ID, Model: "m", Source: SourceAPI, InputTokens: 1, OutputTokens: 1}); err != nil {
					errs <- err
				}
				if _, err := db.AppendMessage(ctx, a.ID, "user", []byte(`[]`)); err != nil {
					errs <- err
				}
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	agents, _ := db.Agents(ctx)
	if len(agents) != 9 {
		t.Fatalf("agents = %d, want 9", len(agents))
	}
}

func TestOpenRelativeDataDir(t *testing.T) {
	t.Chdir(t.TempDir())
	s, err := Open("./data/harness-test")
	if err != nil {
		t.Fatalf("Open relative dataDir: %v", err)
	}
	defer func() { _ = s.Close() }()

	db := create(t, s, "rel", Folder{Label: "a", Path: "/tmp/a"})
	info, err := db.Info(context.Background())
	if err != nil || info.Name != "rel" {
		t.Fatalf("Info = %+v, %v", info, err)
	}
}
