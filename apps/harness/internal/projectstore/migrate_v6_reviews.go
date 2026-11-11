package projectstore

import (
	"context"
	"fmt"
)

// Schema 6 (PR review, RV1) adds the review tables. It is its own file and
// function so the version number can be renumbered when migrations from
// parallel work are merged. The statements are idempotent.
const reviewsSchemaVersion = 6

const reviewsSchema = `
CREATE TABLE IF NOT EXISTS reviews (
	id TEXT PRIMARY KEY,
	source TEXT NOT NULL,
	kind TEXT NOT NULL,
	folder TEXT NOT NULL DEFAULT '',
	repo TEXT NOT NULL DEFAULT '',
	number INTEGER NOT NULL DEFAULT 0,
	title TEXT NOT NULL DEFAULT '',
	body TEXT NOT NULL DEFAULT '',
	author TEXT NOT NULL DEFAULT '',
	url TEXT NOT NULL DEFAULT '',
	base_ref TEXT NOT NULL DEFAULT '',
	head_ref TEXT NOT NULL DEFAULT '',
	base_commit TEXT NOT NULL DEFAULT '',
	head_commit TEXT NOT NULL DEFAULT '',
	worktree_path TEXT NOT NULL DEFAULT '',
	state TEXT NOT NULL DEFAULT 'open',
	last_submitted_head TEXT NOT NULL DEFAULT '',
	last_submitted_at TEXT NOT NULL DEFAULT '',
	meta_json TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	last_used_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reviews_source ON reviews (source);
CREATE TABLE IF NOT EXISTS review_viewed (
	review_id TEXT NOT NULL,
	path TEXT NOT NULL,
	blob TEXT NOT NULL,
	head_commit TEXT NOT NULL,
	viewed_at TEXT NOT NULL,
	PRIMARY KEY (review_id, path)
);
CREATE TABLE IF NOT EXISTS review_findings (
	id TEXT PRIMARY KEY,
	review_id TEXT NOT NULL,
	path TEXT NOT NULL,
	start_line INTEGER NOT NULL DEFAULT 0,
	end_line INTEGER NOT NULL DEFAULT 0,
	severity TEXT NOT NULL DEFAULT 'info',
	statement TEXT NOT NULL DEFAULT '',
	scenario TEXT NOT NULL DEFAULT '',
	patch TEXT NOT NULL DEFAULT '',
	evidence TEXT NOT NULL DEFAULT '',
	verdict TEXT NOT NULL DEFAULT '',
	rank INTEGER NOT NULL DEFAULT 0,
	status TEXT NOT NULL DEFAULT 'new',
	dismiss_reason TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS review_findings_review ON review_findings (review_id, rank);
CREATE TABLE IF NOT EXISTS review_comments (
	id TEXT PRIMARY KEY,
	review_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	path TEXT NOT NULL DEFAULT '',
	side TEXT NOT NULL DEFAULT 'new',
	line INTEGER NOT NULL DEFAULT 0,
	start_line INTEGER NOT NULL DEFAULT 0,
	body TEXT NOT NULL DEFAULT '',
	suggestion TEXT NOT NULL DEFAULT '',
	finding_id TEXT NOT NULL DEFAULT '',
	state TEXT NOT NULL DEFAULT 'pending',
	submission_id TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	submitted_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS review_comments_review ON review_comments (review_id, created_at);
`

// migrateV6Reviews creates the review tables.
func (d *DB) migrateV6Reviews(ctx context.Context) error {
	if _, err := d.sql.ExecContext(ctx, reviewsSchema); err != nil {
		return fmt.Errorf("reviews schema (v%d): %w", reviewsSchemaVersion, err)
	}
	return nil
}
