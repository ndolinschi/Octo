package projectstore

import (
	"context"
	"database/sql"
	"fmt"
)

type column struct{ name, ddl string }

// columnsAdded lists, per table, the columns added after the first release.
var columnsAdded = []struct {
	table   string
	columns []column
}{
	{"agents", []column{
		{"context_used", "INTEGER"}, {"context_size", "INTEGER"},
		{"route_reason", "TEXT"}, {"route_band", "TEXT"}, {"route_request_id", "TEXT"}, {"route_choice", "TEXT"},
		// Schema 4: the latest plan of an ACP agent (JSON array).
		{"plan_json", "TEXT"},
		// Schema 5: what to do about the error (a login hint), kept apart from its text.
		{"error_hint", "TEXT"},
	}},
	{"project", []column{
		{"budget_usd", "REAL"},
		// Projects that predate approvals keep today's behaviour: full access.
		{"access", "TEXT NOT NULL DEFAULT 'full'"}, {"queue_paused", "INTEGER NOT NULL DEFAULT 0"},
		{"memory_json", "TEXT NOT NULL DEFAULT '{}'"},
		// Schema 7: web_fetch is off until the project allows it; private and
		// loopback addresses stay refused unless network_private is set.
		{"network", "TEXT NOT NULL DEFAULT 'off'"}, {"network_private", "INTEGER NOT NULL DEFAULT 0"},
		// Schema 7: the project's default mode (agent, ask or plan).
		{"mode", "TEXT NOT NULL DEFAULT 'agent'"},
	}},
	{"usage", []column{
		{"served_model", "TEXT"}, {"tier", "TEXT"}, {"route_trigger", "TEXT"}, {"router_request_id", "TEXT"},
		{"cost_estimated", "INTEGER NOT NULL DEFAULT 0"}, {"role", "TEXT"}, {"flat_rate", "INTEGER NOT NULL DEFAULT 0"},
		// Schema 5: the token counts of the row are the harness's estimate (an ACP agent reported none).
		{"tokens_estimated", "INTEGER NOT NULL DEFAULT 0"},
	}},
	// Schema 7: a compaction asked for by the user, and how many messages it replaced.
	{"compactions", []column{{"usage_id", "INTEGER"}, {"manual", "INTEGER NOT NULL DEFAULT 0"}, {"message_count", "INTEGER NOT NULL DEFAULT 0"}}},
	// Schema 7: a rewound message / sub-agent stays on disk, hidden.
	{"agents", []column{{"rewound_at", "TEXT"}}},
	{"queue", []column{{"mode", "TEXT NOT NULL DEFAULT ''"}}},
	// Schema 5: an assistant message cut short by cancelling the turn.
	{"messages", []column{{"stopped", "INTEGER NOT NULL DEFAULT 0"}, {"rewound_at", "TEXT"}}},
	// Schema 9 (B11): the agent slash command a user message ran ("" for plain text).
	{"messages", []column{{"command", "TEXT NOT NULL DEFAULT ''"}}},
	// Schema 9 (B11): a clear is a compaction row without a summary that starts a new conversation.
	{"compactions", []column{{"cleared", "INTEGER NOT NULL DEFAULT 0"}, {"conversation_id", "TEXT NOT NULL DEFAULT ''"},
		{"summary_source", "TEXT NOT NULL DEFAULT ''"}, {"title", "TEXT NOT NULL DEFAULT ''"}}},
}

// SchemaVersion is the schema generation this binary writes and understands
// (PRAGMA user_version). Databases without a stamp (0) are older and are
// migrated forward; a higher number was written by a newer binary and is refused.
//
// Numbering: 9 slash commands and /clear (columns), 10 notes, 11 attachments, 12 sessions and exchanges, 13 project
// sessions (kind, parent, state, current; session ids on messages and compactions), 14 task state and the M6 clean-up of
// request-only tasks. The next free version is 15; take it and add `migrate_v15_<name>.go` (parallel work renumbers its
// migration when it lands).
const SchemaVersion = 14

// NewerSchemaError says a database belongs to a newer version of the app. The
// database is not touched.
type NewerSchemaError struct {
	Path    string
	Version int
}

func (e *NewerSchemaError) Error() string {
	return fmt.Sprintf("%s was written by a newer version of the app (database schema %d, this version understands %d up to): "+
		"update the app; the database was left untouched", e.Path, e.Version, SchemaVersion)
}

func userVersion(ctx context.Context, db *sql.DB) (int, error) {
	var v int
	err := db.QueryRowContext(ctx, `PRAGMA user_version`).Scan(&v)
	return v, err
}

// checkVersion refuses a database stamped by a newer binary.
func checkVersion(ctx context.Context, db *sql.DB, path string) error {
	v, err := userVersion(ctx, db)
	if err != nil {
		return err
	}
	if v > SchemaVersion {
		return &NewerSchemaError{Path: path, Version: v}
	}
	return nil
}

func stampVersion(ctx context.Context, db *sql.DB) error {
	_, err := db.ExecContext(ctx, fmt.Sprintf(`PRAGMA user_version = %d`, SchemaVersion))
	return err
}

// migrate brings a project database up to the current schema. It is
// idempotent: new tables use IF NOT EXISTS and columns are added only when
// missing, so it is safe on fresh, current and older databases alike.
func (d *DB) migrate(ctx context.Context) error {
	if err := checkVersion(ctx, d.sql, d.dir); err != nil {
		return err
	}
	if _, err := d.sql.ExecContext(ctx, projectSchema); err != nil {
		return fmt.Errorf("project schema: %w", err)
	}
	for _, t := range columnsAdded {
		have, err := d.columns(ctx, t.table)
		if err != nil {
			return err
		}
		for _, c := range t.columns {
			if have[c.name] {
				continue
			}
			if _, err := d.sql.ExecContext(ctx, "ALTER TABLE "+t.table+" ADD COLUMN "+c.name+" "+c.ddl); err != nil {
				return fmt.Errorf("add %s.%s: %w", t.table, c.name, err)
			}
		}
	}
	// Schema 6: PR review tables (migrate_v6_reviews.go). The chain is 4 (plan) -> 5 (error hint,
	// stopped, tokens estimated, stemmed index) -> 6 (reviews); each step is idempotent, so a
	// database of any earlier version runs the steps it lacks.
	if err := d.migrateV6Reviews(ctx); err != nil {
		return err
	}
	// Schema 7: saved approval rules (migrate_v7.go); the parity features' other
	// additions are the project's network columns above.
	if err := d.migrateV7(ctx); err != nil {
		return err
	}
	// Schema 8: review threads, project settings, command runs (migrate_v8_review_workflow.go).
	if err := d.migrateV8ReviewWorkflow(ctx); err != nil {
		return err
	}
	// Schema 11: attachments (migrate_v11_attachments.go).
	if err := d.migrateV11Attachments(ctx); err != nil {
		return err
	}
	if v, err := userVersion(ctx, d.sql); err != nil {
		return err
	} else if v < 2 {
		// Schema 2 added the search indexes: index what the project already says.
		if err := d.backfillMessages(ctx); err != nil {
			return fmt.Errorf("index existing messages: %w", err)
		}
	}
	if v, err := userVersion(ctx, d.sql); err != nil {
		return err
	} else if v < 5 {
		// Schema 5 added the stemmed index: index what the project already says.
		if err := d.reindexStemmed(ctx); err != nil {
			return fmt.Errorf("index stems: %w", err)
		}
	}
	// Schema 10: notes with descriptions, tags, pins and read counts (migrate_v10_notes.go).
	if err := d.migrateV10Notes(ctx); err != nil {
		return err
	}
	// Schema 12: sessions and exchanges, back-filled (migrate_v12_sessions.go); last: it reads the messages, compactions and notes the steps above leave.
	if err := d.migrateV12Sessions(ctx); err != nil {
		return err
	}
	// Schema 13: project sessions (migrate_v13_sessions.go); after schema 12, whose sessions it extends.
	if err := d.migrateV13Sessions(ctx); err != nil {
		return err
	}
	// Schema 14: task state, closing reason, session; clean-up of request-only tasks (migrate_v14_tasks.go); last: it reads exchanges and sessions.
	if err := d.migrateV14Tasks(ctx); err != nil {
		return err
	}
	return stampVersion(ctx, d.sql)
}

func (d *DB) columns(ctx context.Context, table string) (map[string]bool, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT name FROM pragma_table_info(?)`, table)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		out[n] = true
	}
	return out, rows.Err()
}
