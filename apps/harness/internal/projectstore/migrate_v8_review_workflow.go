package projectstore

import (
	"context"
	"database/sql"
	"fmt"
)

// Schema 8 (review workflow, RV1.5) adds what the review work needs beyond RV1:
// the review threads of the code host, the column that ties a pending comment
// to the thread it replies to, project_settings (a key to JSON table for the
// project's commands, review configuration and active review workspace) and
// command_runs (what the user's project commands did). It is its own file and function so the
// version number can be renumbered when migrations from parallel work are
// merged. Every statement is idempotent.
const reviewWorkflowSchemaVersion = 8

const reviewWorkflowSchema = `
CREATE TABLE IF NOT EXISTS review_threads (
	review_id TEXT PRIMARY KEY,
	threads_json TEXT NOT NULL DEFAULT '[]',
	fetched_at TEXT NOT NULL DEFAULT '',
	error TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS project_settings (
	key TEXT PRIMARY KEY,
	value_json TEXT NOT NULL DEFAULT 'null',
	updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS command_runs (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	command TEXT NOT NULL,
	cwd TEXT NOT NULL DEFAULT '',
	review_id TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL DEFAULT 'running',
	exit_code INTEGER,
	started_at TEXT NOT NULL,
	finished_at TEXT NOT NULL DEFAULT '',
	duration_ms INTEGER NOT NULL DEFAULT 0,
	output_bytes INTEGER NOT NULL DEFAULT 0,
	truncated INTEGER NOT NULL DEFAULT 0,
	tail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS command_runs_started ON command_runs (started_at);
CREATE INDEX IF NOT EXISTS command_runs_review ON command_runs (review_id, started_at);
`

func (d *DB) migrateV8ReviewWorkflow(ctx context.Context) error {
	if _, err := d.sql.ExecContext(ctx, reviewWorkflowSchema); err != nil {
		return fmt.Errorf("review workflow schema (v%d): %w", reviewWorkflowSchemaVersion, err)
	}
	have, err := d.columns(ctx, "review_comments")
	if err != nil {
		return err
	}
	if !have["in_reply_to"] {
		if _, err := d.sql.ExecContext(ctx, `ALTER TABLE review_comments ADD COLUMN in_reply_to TEXT NOT NULL DEFAULT ''`); err != nil {
			return fmt.Errorf("add review_comments.in_reply_to: %w", err)
		}
	}
	return nil
}

// ReviewThreadsRow is what is stored of a review's code-host threads: the JSON
// list (untrusted text, kept verbatim), when it was fetched, and the error of
// the last failed fetch ("" when it worked).
type ReviewThreadsRow struct {
	JSON      string
	FetchedAt string
	Error     string
}

// SetReviewThreads stores a review's threads.
func (d *DB) SetReviewThreads(ctx context.Context, reviewID string, row ReviewThreadsRow) error {
	_, err := d.sql.ExecContext(ctx, `INSERT INTO review_threads (review_id, threads_json, fetched_at, error) VALUES (?,?,?,?)
		ON CONFLICT(review_id) DO UPDATE SET threads_json = excluded.threads_json, fetched_at = excluded.fetched_at, error = excluded.error`,
		reviewID, row.JSON, row.FetchedAt, row.Error)
	return err
}

// SetReviewThreadsError records a failed fetch and keeps the threads stored before.
func (d *DB) SetReviewThreadsError(ctx context.Context, reviewID, msg string) error {
	_, err := d.sql.ExecContext(ctx, `INSERT INTO review_threads (review_id, error) VALUES (?,?)
		ON CONFLICT(review_id) DO UPDATE SET error = excluded.error`, reviewID, msg)
	return err
}

// ReviewThreads returns a review's stored threads; ErrNotFound when none were ever fetched.
func (d *DB) ReviewThreads(ctx context.Context, reviewID string) (ReviewThreadsRow, error) {
	var r ReviewThreadsRow
	err := d.sql.QueryRowContext(ctx, `SELECT threads_json, fetched_at, error FROM review_threads WHERE review_id = ?`, reviewID).
		Scan(&r.JSON, &r.FetchedAt, &r.Error)
	if err == sql.ErrNoRows {
		return r, ErrNotFound
	}
	return r, err
}

// Keys of project_settings.
const (
	SettingCommands        = "commands"
	SettingReviewConfig    = "review"
	SettingReviewWorkspace = "review_workspace"
)

// Setting returns the JSON stored under key ("" and false when none).
func (d *DB) Setting(ctx context.Context, key string) (string, bool, error) {
	var v string
	err := d.sql.QueryRowContext(ctx, `SELECT value_json FROM project_settings WHERE key = ?`, key).Scan(&v)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	return v, err == nil, err
}

// SetSetting stores JSON under key.
func (d *DB) SetSetting(ctx context.Context, key, valueJSON string) error {
	_, err := d.sql.ExecContext(ctx, `INSERT INTO project_settings (key, value_json, updated_at) VALUES (?,?,?)
		ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`, key, valueJSON, Now())
	return err
}

// DeleteSetting removes key.
func (d *DB) DeleteSetting(ctx context.Context, key string) error {
	_, err := d.sql.ExecContext(ctx, `DELETE FROM project_settings WHERE key = ?`, key)
	return err
}
