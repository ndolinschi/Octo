package projectstore

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

// Schema 14 (memory M6: a task is work, not every request) adds the state,
// the closing reason and the session to a task record, and cleans up the
// request-only tasks earlier versions made. It is its own file and function so
// the version number can be renumbered when migrations from parallel work are
// merged. The columns are idempotent; the clean-up runs once, for a database
// stamped below 14, after a backup of the database is written next to it.
const tasksSchemaVersion = 14

// BackupSuffix is appended to project.sqlite for the copy the clean-up writes
// before it removes anything (restore it by replacing project.sqlite).
const BackupSuffix = ".pre-m6"

var taskColumns = []column{
	{"state_summary", "TEXT NOT NULL DEFAULT ''"},
	{"closed_reason", "TEXT NOT NULL DEFAULT ''"},
	{"session_id", "TEXT NOT NULL DEFAULT ''"},
}

// CleanupReport says what the M6 clean-up did.
type CleanupReport struct {
	Removed, Merged int
	Backup          string
}

func (d *DB) migrateV14Tasks(ctx context.Context) error {
	have, err := d.columns(ctx, "tasks")
	if err != nil {
		return err
	}
	for _, c := range taskColumns {
		if !have[c.name] {
			if _, err := d.sql.ExecContext(ctx, "ALTER TABLE tasks ADD COLUMN "+c.name+" "+c.ddl); err != nil {
				return fmt.Errorf("add tasks.%s (v%d): %w", c.name, tasksSchemaVersion, err)
			}
		}
	}
	if v, err := userVersion(ctx, d.sql); err != nil {
		return err
	} else if v >= tasksSchemaVersion {
		return nil
	}
	rep, err := d.cleanupRequestOnlyTasks(ctx)
	if err != nil {
		return fmt.Errorf("task clean-up (v%d): %w", tasksSchemaVersion, err)
	}
	if rep.Removed+rep.Merged > 0 {
		slog.Info("memory M6 clean-up of task records", "project", d.id, "removed", rep.Removed, "merged", rep.Merged, "backup", rep.Backup)
	}
	return nil
}

// hasContent: a task is more than the request it restates when it holds a
// constraint, acceptance criterion, decision, fact or file.
func hasContent(t Task) bool {
	return len(t.Constraints)+len(t.Acceptance)+len(t.Decisions)+len(t.Facts)+len(t.Files) > 0
}

// cleanupRequestOnlyTasks removes the tasks that hold nothing but the goal (the
// request's first words) and merges duplicates by title within a day. Their
// exchanges stay. Nothing is touched before the backup is written.
func (d *DB) cleanupRequestOnlyTasks(ctx context.Context) (CleanupReport, error) {
	var rep CleanupReport
	tasks, err := d.Tasks(ctx)
	if err != nil {
		return rep, err
	}
	order := map[string]int{} // creation order (rowid breaks ties of the same millisecond)
	if rows, qerr := d.sql.QueryContext(ctx, `SELECT id FROM tasks ORDER BY created_at, rowid`); qerr == nil {
		for rows.Next() {
			var id string
			if rows.Scan(&id) == nil {
				order[id] = len(order)
			}
		}
		_ = rows.Close()
	}
	slices.SortFunc(tasks, func(a, b Task) int { return order[a.ID] - order[b.ID] })
	var gone []Task
	var keep []Task
	for _, t := range tasks { // oldest first
		if !hasContent(t) && t.Title != "Remembered" {
			gone = append(gone, t)
		} else {
			keep = append(keep, t)
		}
	}
	merges := map[string]string{} // merged task id -> survivor
	survivors := map[string]*Task{}
	var final []*Task
	for i := range keep {
		t := keep[i]
		key := strings.ToLower(strings.Join(strings.Fields(t.Title), " ")) + "|" + dayOf(t.CreatedAt)
		if s := survivors[key]; s != nil && t.Title != "Remembered" {
			mergeTask(s, t)
			merges[t.ID] = s.ID
			rep.Merged++
			continue
		}
		survivors[key] = &keep[i]
		final = append(final, &keep[i])
	}
	rep.Removed = len(gone)
	if rep.Removed+rep.Merged > 0 {
		if rep.Backup, err = d.backupBeforeCleanup(ctx); err != nil {
			return rep, err
		}
	}
	for _, t := range final {
		d.finishOldTask(ctx, t) // reads before the transaction: the pool has one connection
	}
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return rep, err
	}
	defer func() { _ = tx.Rollback() }()
	for _, t := range gone {
		if err := d.deleteTaskTx(ctx, tx, t.ID); err != nil {
			return rep, err
		}
	}
	for from, to := range merges {
		if err := d.deleteTaskTx(ctx, tx, from); err != nil {
			return rep, err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE exchanges SET task_id = ? WHERE task_id = ?`, to, from); err != nil {
			return rep, err
		}
	}
	for _, t := range final {
		data, err := t.data()
		if err != nil {
			return rep, err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE tasks SET goal=?, goal_by=?, data_json=?, closed_reason=?, session_id=?, outcome=?, updated_at=? WHERE id=?`,
			t.Goal, t.GoalBy, string(data), t.ClosedReason, t.SessionID, t.Outcome, t.UpdatedAt, t.ID); err != nil {
			return rep, err
		}
		if err := d.indexTask(ctx, tx, *t); err != nil {
			return rep, err
		}
	}
	return rep, tx.Commit()
}

// finishOldTask gives a kept task the M6 shape: the raw-request goal becomes a
// minimal rewrite, a closed task gets a reason, the session comes from its first exchange.
func (d *DB) finishOldTask(ctx context.Context, t *Task) {
	if t.GoalBy == "harness" {
		if g := GoalFromRequest(t.Goal); g != "" {
			t.Goal, t.GoalBy = g, "rule"
		}
	}
	if t.ClosedReason == "" {
		switch t.Status {
		case TaskDone:
			t.ClosedReason = "turn completed"
		case TaskDropped:
			t.ClosedReason = "stopped"
		}
	}
	if t.SessionID == "" && len(t.MessageIDs) > 0 {
		var sid string
		if d.sql.QueryRowContext(ctx, `SELECT session_id FROM exchanges WHERE turn_id = ?`, t.MessageIDs[0]).Scan(&sid) == nil {
			t.SessionID = sid
		}
	}
}

func dayOf(ts string) string {
	if len(ts) >= 10 {
		return ts[:10]
	}
	return ts
}

// mergeTask folds src (newer) into dst: lists unioned, facts renumbered with
// their superseded_by links kept, messages joined, dst's goal kept.
func mergeTask(dst *Task, src Task) {
	union := func(a, b []string) []string {
		for _, x := range b {
			if !slices.Contains(a, x) {
				a = append(a, x)
			}
		}
		return a
	}
	dst.Constraints = union(dst.Constraints, src.Constraints)
	dst.Acceptance = union(dst.Acceptance, src.Acceptance)
	dst.Decisions = union(dst.Decisions, src.Decisions)
	dst.Files = union(dst.Files, src.Files)
	dst.OpenQuestions = union(dst.OpenQuestions, src.OpenQuestions)
	for _, q := range src.Quotes {
		if !slices.ContainsFunc(dst.Quotes, func(x Quote) bool { return x.Text == q.Text }) {
			dst.Quotes = append(dst.Quotes, q)
		}
	}
	renamed := map[string]string{}
	next := 0
	for _, f := range dst.Facts {
		if n, err := strconv.Atoi(strings.TrimPrefix(f.ID, "f")); err == nil && n > next {
			next = n
		}
	}
	start := len(dst.Facts)
	for _, f := range src.Facts {
		next++
		renamed[f.ID] = "f" + strconv.Itoa(next)
		f.ID = renamed[f.ID]
		dst.Facts = append(dst.Facts, f)
	}
	for i := start; i < len(dst.Facts); i++ {
		if by, ok := renamed[dst.Facts[i].SupersededBy]; ok {
			dst.Facts[i].SupersededBy = by
		}
	}
	for _, m := range src.MessageIDs {
		if !slices.Contains(dst.MessageIDs, m) {
			dst.MessageIDs = append(dst.MessageIDs, m)
		}
	}
	if src.Outcome != "" {
		dst.Outcome = src.Outcome
	}
	if src.UpdatedAt > dst.UpdatedAt {
		dst.UpdatedAt = src.UpdatedAt
		dst.Status, dst.ClosedReason = src.Status, src.ClosedReason
	}
}

func (d *DB) deleteTaskTx(ctx context.Context, x execer, id string) error {
	if _, err := x.ExecContext(ctx, `DELETE FROM tasks WHERE id = ?`, id); err != nil {
		return err
	}
	if _, err := x.ExecContext(ctx, `UPDATE exchanges SET task_id = '' WHERE task_id = ?`, id); err != nil {
		return err
	}
	if err := delDoc(ctx, x, DocTask, id); err != nil {
		return err
	}
	return delDoc(ctx, x, DocFact, id+"/")
}

// backupBeforeCleanup writes a consistent copy of the database to
// project.sqlite.pre-m6 (a numbered name when one exists) with VACUUM INTO.
func (d *DB) backupBeforeCleanup(ctx context.Context) (string, error) {
	base := filepath.Join(d.dir, "project.sqlite"+BackupSuffix)
	path := base
	for i := 1; ; i++ {
		if _, err := os.Stat(path); os.IsNotExist(err) {
			break
		}
		path = base + "." + strconv.Itoa(i)
	}
	if _, err := d.sql.ExecContext(ctx, `VACUUM INTO ?`, path); err != nil {
		return "", fmt.Errorf("write the backup %s: %w", path, err)
	}
	return path, nil
}
