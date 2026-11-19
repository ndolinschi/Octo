package projectstore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
)

// Schema 15 (parallel sessions, spec 2026-11-14-parallel-sessions-design.md section 7): every main session is
// addressable and has its own root agent row (sessions.root_agent_id, agents.session_id), its own queue
// (queue.session_id, sessions.queue_paused) and the columns later phases need (workspaces, memory mode,
// coordination). The columns and tables are idempotent; the data rewrite runs once, for a database stamped
// below 15, after a backup written next to the database when there is anything to move. Own file and function
// so the number can be renumbered when parallel migrations land.
const parallelSessionsVersion = 15

// BackupSuffixV15 is appended to project.sqlite for the copy written before the v15 rewrite.
const BackupSuffixV15 = ".pre-v15"

// SharedWorkspace is the id of the project's own folders as they are on disk.
const SharedWorkspace = "shared"

var v15Columns = []struct {
	table string
	cols  []column
}{
	{"sessions", []column{
		{"workspace_id", "TEXT NOT NULL DEFAULT 'shared'"},
		{"memory_mode", "TEXT NOT NULL DEFAULT 'on'"},
		{"mode", "TEXT NOT NULL DEFAULT ''"},
		{"queue_paused", "INTEGER NOT NULL DEFAULT 0"},
		{"root_agent_id", "TEXT NOT NULL DEFAULT ''"},
	}},
	{"agents", []column{{"session_id", "TEXT NOT NULL DEFAULT ''"}}},
	{"queue", []column{{"session_id", "TEXT NOT NULL DEFAULT ''"}, {"waiting_for", "TEXT NOT NULL DEFAULT ''"}}},
	{"changes", []column{
		{"session_id", "TEXT NOT NULL DEFAULT ''"},
		{"workspace_id", "TEXT NOT NULL DEFAULT 'shared'"},
		{"attribution", "TEXT NOT NULL DEFAULT 'exact'"},
	}},
	{"command_runs", []column{{"workspace_id", "TEXT NOT NULL DEFAULT 'shared'"}}},
	{"plans", []column{{"session_id", "TEXT NOT NULL DEFAULT ''"}}},
	{"exchanges", []column{{"private", "INTEGER NOT NULL DEFAULT 0"}}},
	{"search_docs", []column{{"session_id", "TEXT NOT NULL DEFAULT ''"}}},
}

// The workspace and coordination tables are created now (later phases fill them) so no further rewrite is needed.
const parallelSessionsSchema = `
CREATE INDEX IF NOT EXISTS agents_session ON agents (session_id);
CREATE INDEX IF NOT EXISTS queue_session ON queue (session_id, seq);
CREATE TABLE IF NOT EXISTS workspaces (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	title TEXT NOT NULL DEFAULT '',
	state TEXT NOT NULL DEFAULT 'ready',
	carry_changes INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	removed_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS workspace_folders (
	workspace_id TEXT NOT NULL,
	folder_id TEXT NOT NULL,
	path TEXT NOT NULL,
	repo_root TEXT NOT NULL DEFAULT '',
	branch TEXT NOT NULL DEFAULT '',
	base_branch TEXT NOT NULL DEFAULT '',
	base_commit TEXT NOT NULL DEFAULT '',
	shared INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (workspace_id, folder_id)
);
CREATE TABLE IF NOT EXISTS session_declarations (
	session_id TEXT PRIMARY KEY,
	summary TEXT NOT NULL,
	steps_json TEXT NOT NULL DEFAULT '[]',
	updated_at TEXT NOT NULL,
	expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS file_claims (
	id INTEGER PRIMARY KEY,
	session_id TEXT NOT NULL,
	workspace_id TEXT NOT NULL,
	folder_id TEXT NOT NULL,
	path TEXT NOT NULL,
	intent TEXT NOT NULL,
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_messages (
	id INTEGER PRIMARY KEY,
	kind TEXT NOT NULL,
	from_session_id TEXT NOT NULL,
	to_session_id TEXT NOT NULL,
	text TEXT NOT NULL,
	answer_json TEXT NOT NULL DEFAULT '',
	reply_requested INTEGER NOT NULL DEFAULT 0,
	turn_id INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	delivered_at TEXT
);
`

func (d *DB) migrateV15ParallelSessions(ctx context.Context) error {
	for _, t := range v15Columns {
		have, err := d.columns(ctx, t.table)
		if err != nil {
			return err
		}
		for _, c := range t.cols {
			if have[c.name] {
				continue
			}
			if _, err := d.sql.ExecContext(ctx, "ALTER TABLE "+t.table+" ADD COLUMN "+c.name+" "+c.ddl); err != nil {
				return fmt.Errorf("add %s.%s (v%d): %w", t.table, c.name, parallelSessionsVersion, err)
			}
		}
	}
	if _, err := d.sql.ExecContext(ctx, parallelSessionsSchema); err != nil {
		return fmt.Errorf("parallel sessions schema (v%d): %w", parallelSessionsVersion, err)
	}
	if v, err := userVersion(ctx, d.sql); err != nil {
		return err
	} else if v >= parallelSessionsVersion {
		return nil
	}
	rep, err := d.backfillParallelSessions(ctx)
	if err != nil {
		return fmt.Errorf("parallel sessions back-fill (v%d): %w", parallelSessionsVersion, err)
	}
	if rep.Roots > 0 || rep.Backup != "" {
		slog.Info("parallel sessions back-fill", "project", d.id, "roots", rep.Roots, "messages_moved", rep.Messages, "backup", rep.Backup)
	}
	return nil
}

// BackfillReport says what the v15 back-fill did: the root agents it made for sessions other than the default,
// the messages it moved to them and the backup it wrote first ("" when nothing had to move).
type BackfillReport struct {
	Roots, Messages int
	Backup          string
}

// backfillParallelSessions gives every main session that holds messages its own root agent (the default keeps the
// project's orchestrator row), moves its messages, compactions and sub-agents to it, and fills the new session
// columns of agents, queue, changes, plans and search documents. One transaction, after the backup.
func (d *DB) backfillParallelSessions(ctx context.Context) (BackfillReport, error) {
	var rep BackfillReport
	var orch string
	err := d.sql.QueryRowContext(ctx, `SELECT id FROM agents WHERE parent_id IS NULL AND session_id = '' ORDER BY rowid LIMIT 1`).Scan(&orch)
	if errors.Is(err, sql.ErrNoRows) {
		// A new database (the project row and its orchestrator are written by init) or one already done.
		_, err = d.sql.ExecContext(ctx, `INSERT OR IGNORE INTO workspaces (id, kind, title, state, created_at) VALUES (?, 'shared', 'Main checkout', 'ready', ?)`, SharedWorkspace, Now())
		return rep, err
	}
	if err != nil {
		return rep, err
	}
	var moving int
	if err := d.sql.QueryRowContext(ctx, `SELECT COUNT(*) FROM sessions s WHERE s.kind = 'main' AND s.current = 0 AND s.root_agent_id = ''
		AND EXISTS (SELECT 1 FROM messages m WHERE m.agent_id = ? AND m.session_id = s.id)`, orch).Scan(&moving); err != nil {
		return rep, err
	}
	if moving > 0 {
		if rep.Backup, err = d.backupAs(ctx, BackupSuffixV15); err != nil {
			return rep, err
		}
	}
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return rep, err
	}
	defer func() { _ = tx.Rollback() }()
	now := Now()
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO workspaces (id, kind, title, state, created_at) VALUES (?, 'shared', 'Main checkout', 'ready', ?)`, SharedWorkspace, now); err != nil {
		return rep, err
	}
	def, err := ensureCurrentMain(ctx, tx)
	if err != nil {
		return rep, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE sessions SET root_agent_id = ? WHERE id = ? AND root_agent_id = ''`, orch, def); err != nil {
		return rep, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE agents SET session_id = ? WHERE id = ?`, def, orch); err != nil {
		return rep, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE sessions SET workspace_id = ?, memory_mode = 'on' WHERE kind = 'main'`, SharedWorkspace); err != nil {
		return rep, err
	}
	type mainSession struct{ id, started, ended, acpAgent, acpModel, acpSession string }
	rows, err := tx.QueryContext(ctx, `SELECT s.id, s.started_at, s.ended_at, s.acp_agent, s.acp_model, s.acp_session_id FROM sessions s
		WHERE s.kind = 'main' AND s.id != ? AND s.root_agent_id = '' AND EXISTS (SELECT 1 FROM messages m WHERE m.agent_id = ? AND m.session_id = s.id)
		ORDER BY s.started_at, s.rowid`, def, orch)
	if err != nil {
		return rep, err
	}
	var others []mainSession
	for rows.Next() {
		var s mainSession
		if err := rows.Scan(&s.id, &s.started, &s.ended, &s.acpAgent, &s.acpModel, &s.acpSession); err != nil {
			_ = rows.Close()
			return rep, err
		}
		others = append(others, s)
	}
	if err := rows.Close(); err != nil {
		return rep, err
	}
	for _, s := range others {
		root := NewID("agt")
		// The new root copies the orchestrator's role, title, model and tier; it is not running.
		if _, err := tx.ExecContext(ctx, `INSERT INTO agents (id, parent_id, depth, role, title, task, model, tier, status, created_at, started_at, finished_at, session_id)
			SELECT ?, NULL, 0, role, title, task, model, tier, 'completed', ?, ?, ?, ? FROM agents WHERE id = ?`,
			root, s.started, s.started, s.ended, s.id, orch); err != nil {
			return rep, err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE sessions SET root_agent_id = ? WHERE id = ?`, root, s.id); err != nil {
			return rep, err
		}
		res, err := tx.ExecContext(ctx, `UPDATE messages SET agent_id = ? WHERE agent_id = ? AND session_id = ?`, root, orch, s.id)
		if err != nil {
			return rep, err
		}
		n, _ := res.RowsAffected()
		rep.Messages += int(n)
		for _, q := range []string{
			`UPDATE compactions SET agent_id = ? WHERE agent_id = ? AND session_id = ?`,
			`UPDATE agents SET parent_id = ? WHERE parent_id = ? AND id IN (SELECT agent_id FROM sessions WHERE kind = 'agent' AND parent_session_id = ?)`,
		} {
			if _, err := tx.ExecContext(ctx, q, root, orch, s.id); err != nil {
				return rep, err
			}
		}
		if s.acpSession != "" {
			// The ACP session the agent kept for this session belongs to its own root from now on.
			if _, err := tx.ExecContext(ctx, `INSERT OR REPLACE INTO acp_sessions (agent_id, plugin_agent, model, session_id, updated_at) VALUES (?, ?, ?, ?, ?)`,
				root, s.acpAgent, s.acpModel, s.acpSession, now); err != nil {
				return rep, err
			}
		}
		rep.Roots++
	}
	if err := fillSessionColumns(ctx, tx, def); err != nil {
		return rep, err
	}
	return rep, tx.Commit()
}

// fillSessionColumns fills agents.session_id (sub-agents through their agent session and the parent chain),
// the queue (the default session, with the project's pause), changes and plans (the session of the turn's user
// message) and the search documents (the exchange's or the message's session).
func fillSessionColumns(ctx context.Context, tx *sql.Tx, def string) error {
	stmts := []struct {
		q    string
		args []any
	}{
		{`UPDATE agents SET session_id = (SELECT s.parent_session_id FROM sessions s WHERE s.kind = 'agent' AND s.agent_id = agents.id)
			WHERE session_id = '' AND parent_id IS NOT NULL AND EXISTS (SELECT 1 FROM sessions s WHERE s.kind = 'agent' AND s.agent_id = agents.id AND s.parent_session_id != '')`, nil},
	}
	for i := 0; i < 12; i++ { // the parent chain, one level per pass (depth is at most config.MaxDepthLimit)
		stmts = append(stmts, struct {
			q    string
			args []any
		}{`UPDATE agents SET session_id = (SELECT p.session_id FROM agents p WHERE p.id = agents.parent_id)
			WHERE session_id = '' AND parent_id IS NOT NULL AND COALESCE((SELECT p.session_id FROM agents p WHERE p.id = agents.parent_id), '') != ''`, nil})
	}
	stmts = append(stmts, []struct {
		q    string
		args []any
	}{
		{`UPDATE agents SET session_id = ? WHERE session_id = ''`, []any{def}},
		{`UPDATE queue SET session_id = ?, waiting_for = 'turn' WHERE session_id = ''`, []any{def}},
		{`UPDATE sessions SET queue_paused = (SELECT queue_paused FROM project WHERE id = 1) WHERE id = ? AND EXISTS (SELECT 1 FROM project WHERE id = 1)`, []any{def}},
		{`UPDATE changes SET session_id = COALESCE((SELECT NULLIF(m.session_id, '') FROM messages m WHERE m.id = changes.turn_id), ?) WHERE session_id = ''`, []any{def}},
		{`UPDATE plans SET session_id = COALESCE((SELECT NULLIF(m.session_id, '') FROM messages m WHERE m.id = plans.turn_id), ?) WHERE session_id = ''`, []any{def}},
		{`UPDATE search_docs SET session_id = COALESCE((SELECT x.session_id FROM exchanges x WHERE x.id = search_docs.ref), '') WHERE kind = 'exchange' AND session_id = ''`, nil},
		{`UPDATE search_docs SET session_id = COALESCE((SELECT COALESCE(NULLIF(m.session_id, ''), a.session_id) FROM messages m JOIN agents a ON a.id = m.agent_id
			WHERE m.id = CAST(search_docs.ref AS INTEGER)), '') WHERE kind = 'message' AND session_id = ''`, nil},
	}...)
	for _, s := range stmts {
		if _, err := tx.ExecContext(ctx, s.q, s.args...); err != nil {
			return err
		}
	}
	return nil
}

// backupAs writes a consistent copy of the database to project.sqlite<suffix> (a numbered name when one exists)
// with VACUUM INTO.
func (d *DB) backupAs(ctx context.Context, suffix string) (string, error) {
	base := filepath.Join(d.dir, "project.sqlite"+suffix)
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
	makePrivate(path)
	return path, nil
}
