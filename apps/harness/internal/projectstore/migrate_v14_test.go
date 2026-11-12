package projectstore

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// A database shaped like the owner's Tasks list (ten tasks that only restate a
// request, three of them the same title, four open) plus real work, stamped 12
// or 13: opening it removes the request-only tasks, merges the duplicates by
// title within a day, keeps the exchanges, rewrites a raw-request goal, and
// leaves a backup of the database from before the clean-up.
func TestMigrateToSchema14CleansRequestOnlyTasks(t *testing.T) {
	for _, from := range []int{12, 13} {
		t.Run(fmt.Sprintf("from_%d", from), func(t *testing.T) { cleanupFrom(t, from) })
	}
}

func cleanupFrom(t *testing.T, from int) {
	ctx := context.Background()
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	db, err := s.Create(ctx, NewProject{Name: "p", ModelsJSON: "{}", MaxDepth: 1, OrchestratorModel: "m"})
	if err != nil {
		t.Fatal(err)
	}
	pid := db.ID()
	titles := []string{"What is about this repo", "What is about this repo", "What is about this repo", "какие у тебя есть заметки?",
		"hello", "explain the router", "list the tools", "what is Octo", "how does memory work", "who are you"}
	var requestOnly []string
	for i, title := range titles {
		st := TaskOpen
		if i%5 == 4 {
			st = TaskDone
		}
		tk, err := db.CreateTask(ctx, Task{Title: title, Goal: "Please " + title, GoalBy: "harness", Auto: true, Status: st, MessageIDs: []int64{int64(i + 1)}})
		if err != nil {
			t.Fatal(err)
		}
		requestOnly = append(requestOnly, tk.ID)
		exec(t, db, `INSERT INTO exchanges (id, session_id, turn_id, request, answer, status, started_at, task_id) VALUES (?, 'ses_x', ?, ?, 'a', 'completed', ?, ?)`,
			fmt.Sprintf("exc_%d", i), i+1, title, Now(), tk.ID)
	}
	work, _ := db.CreateTask(ctx, Task{Title: "Add retry", Goal: "Please add a retry to the uploader", GoalBy: "harness", Status: TaskOpen,
		Files: []string{"up.go"}, MessageIDs: []int64{100}})
	dupA, _ := db.CreateTask(ctx, Task{Title: "Fix port", Goal: "Fix port", GoalBy: "orchestrator", Decisions: []string{"use 8791"}, MessageIDs: []int64{101}})
	dupB, _ := db.CreateTask(ctx, Task{Title: "fix  PORT", Goal: "Fix port", GoalBy: "orchestrator", Facts: []Fact{{ID: "f1", Text: "port is 8791", Date: Now()}}, MessageIDs: []int64{102}})
	other, _ := db.CreateTask(ctx, Task{Title: "Fix port", Goal: "Fix port", GoalBy: "orchestrator", Decisions: []string{"yesterday"}, MessageIDs: []int64{103}})
	exec(t, db, `UPDATE tasks SET created_at = '2026-01-01T09:00:00.000Z' WHERE id = ?`, other.ID)
	remembered, _ := db.CreateTask(ctx, Task{Title: "Remembered", Status: TaskDone, GoalBy: "harness"})
	// Shape it like an older database: no M6 columns, stamped with the older version.
	for _, c := range taskColumns {
		exec(t, db, `ALTER TABLE tasks DROP COLUMN `+c.name)
	}
	exec(t, db, fmt.Sprintf(`PRAGMA user_version = %d`, from))
	_ = s.Close()

	s, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	db, err = s.Get(ctx, pid)
	if err != nil {
		t.Fatal(err)
	}
	tasks, _ := db.Tasks(ctx)
	byID := map[string]Task{}
	for _, tk := range tasks {
		byID[tk.ID] = tk
	}
	for _, id := range requestOnly {
		if _, ok := byID[id]; ok {
			t.Errorf("request-only task %s survived", id)
		}
	}
	if _, ok := byID[remembered.ID]; !ok {
		t.Error("the Remembered record was removed")
	}
	if len(tasks) != 4 { // work, the merged "Fix port" (dupA+dupB), the other day's "Fix port", Remembered
		t.Fatalf("%d tasks left: %+v", len(tasks), tasks)
	}
	merged := byID[dupA.ID]
	if _, gone := byID[dupB.ID]; gone || len(merged.Decisions) != 1 || len(merged.Facts) != 1 || len(merged.MessageIDs) != 2 {
		t.Fatalf("duplicates were not merged into the older: %+v", merged)
	}
	if _, ok := byID[other.ID]; !ok {
		t.Error("a task of another day was merged")
	}
	if g := byID[work.ID]; g.Goal != "Add a retry to the uploader" || g.GoalBy != "rule" {
		t.Errorf("the raw-request goal was not rewritten: %q by %q", g.Goal, g.GoalBy)
	}
	// Exchanges stay; they no longer point at deleted tasks.
	var n, dangling int
	_ = db.sql.QueryRow(`SELECT COUNT(*), COALESCE(SUM(task_id != ''), 0) FROM exchanges`).Scan(&n, &dangling)
	if n != 10 || dangling != 0 {
		t.Errorf("exchanges = %d, with a task = %d", n, dangling)
	}
	// The search index holds no document of a removed task.
	var docs int
	_ = db.sql.QueryRow(`SELECT COUNT(*) FROM search_docs WHERE kind = ? AND ref = ?`, DocTask, requestOnly[0]).Scan(&docs)
	if docs != 0 {
		t.Errorf("a removed task is still indexed")
	}
	// The backup holds the database as it was: all the tasks, none of the clean-up.
	backup := filepath.Join(s.ProjectDir(pid), "project.sqlite"+BackupSuffix)
	raw, err := sql.Open("sqlite", "file:"+backup+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	var before int
	if err := raw.QueryRow(`SELECT COUNT(*) FROM tasks`).Scan(&before); err != nil || before != len(titles)+5 {
		t.Fatalf("backup has %d tasks (%v), want %d", before, err, len(titles)+5)
	}
	// Once stamped, the clean-up does not run again: a request-only task made later stays.
	late, _ := db.CreateTask(ctx, Task{Title: "late", Goal: "late", GoalBy: "rule"})
	_ = s.Close()
	s2, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	db2, _ := s2.Get(ctx, pid)
	if _, err := db2.Task(ctx, late.ID); err != nil {
		t.Errorf("the clean-up ran twice: %v", err)
	}
}

func exec(t *testing.T, db *DB, q string, args ...any) {
	t.Helper()
	if _, err := db.sql.Exec(q, args...); err != nil {
		t.Fatalf("%s: %v", q, err)
	}
}

// A database with nothing to clean writes no backup and the new columns exist.
func TestMigrateToSchema14WritesNoBackupWhenThereIsNothingToClean(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	s, _ := Open(dir)
	db, _ := s.Create(ctx, NewProject{Name: "p", ModelsJSON: "{}", MaxDepth: 1, OrchestratorModel: "m"})
	pid := db.ID()
	_, _ = db.CreateTask(ctx, Task{Title: "real", Goal: "real", Files: []string{"a.go"}})
	for _, c := range taskColumns {
		exec(t, db, `ALTER TABLE tasks DROP COLUMN `+c.name)
	}
	exec(t, db, `PRAGMA user_version = 12`)
	_ = s.Close()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := os.Stat(filepath.Join(s.ProjectDir(pid), "project.sqlite"+BackupSuffix)); !os.IsNotExist(err) {
		t.Fatalf("a backup was written for nothing: %v", err)
	}
	db, _ = s.Get(ctx, pid)
	if ts, _ := db.Tasks(ctx); len(ts) != 1 || ts[0].ClosedReason != "" {
		t.Fatalf("tasks = %+v", ts)
	}
}
