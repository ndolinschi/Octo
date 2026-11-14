package projectstore

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
)

// Schema 13 (project sessions) turns the memory sessions of schema 12 into the project's sessions: a session
// has a kind (a main conversation or the session of a sub-agent), a parent, a state, a model, an editable
// title and an archive flag; exactly one main session is current. Messages and compactions of the
// orchestrator carry the session they belong to, so a session can be resumed later. Own file and function so
// the number can be renumbered when parallel migrations land; every statement is idempotent.
const projectSessionsVersion = 13

// sessionColumns are the columns schema 13 adds to `sessions`. They are added right after the table exists
// (also for a database that is being migrated from before schema 12), because the exchange code reads them.
var sessionColumns = []column{
	{"kind", "TEXT NOT NULL DEFAULT 'main'"},
	{"parent_session_id", "TEXT NOT NULL DEFAULT ''"},
	{"agent_id", "TEXT NOT NULL DEFAULT ''"},
	{"state", "TEXT NOT NULL DEFAULT ''"},
	{"model", "TEXT NOT NULL DEFAULT ''"},
	{"title_edited", "INTEGER NOT NULL DEFAULT 0"},
	{"archived", "INTEGER NOT NULL DEFAULT 0"},
	{"current", "INTEGER NOT NULL DEFAULT 0"},
	// turn_id: the user message of the turn that spawned an agent session (0: not known).
	{"turn_id", "INTEGER NOT NULL DEFAULT 0"},
	// The ACP session the agent kept for this session, to resume it with session/load.
	{"acp_agent", "TEXT NOT NULL DEFAULT ''"},
	{"acp_model", "TEXT NOT NULL DEFAULT ''"},
	{"acp_session_id", "TEXT NOT NULL DEFAULT ''"},
}

const projectSessionsSchema = `
CREATE INDEX IF NOT EXISTS sessions_kind ON sessions (kind, started_at);
CREATE TABLE IF NOT EXISTS session_reports (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	session_id TEXT NOT NULL,
	from_session_id TEXT NOT NULL DEFAULT '',
	text TEXT NOT NULL,
	created_at TEXT NOT NULL,
	delivered_at TEXT
);
`

// addSessionColumns adds schema 13's columns to sessions, messages and compactions where missing.
func (d *DB) addSessionColumns(ctx context.Context) error {
	for _, t := range []struct {
		table string
		cols  []column
	}{
		{"sessions", sessionColumns},
		{"messages", []column{{"session_id", "TEXT NOT NULL DEFAULT ''"}}},
		{"compactions", []column{{"session_id", "TEXT NOT NULL DEFAULT ''"}}},
		// An exchange closed at start because the harness stopped while its turn ran (no version of its own: older
		// binaries never read it and their inserts get the default).
		{"exchanges", []column{{"interrupted", "INTEGER NOT NULL DEFAULT 0"},
			// Schema 15: why a failed turn failed (catalogue code, message, hint; JSON, "" when none). Added here, with
			// the table, because the back-fill of schema 12 already writes exchanges.
			{"error_json", "TEXT NOT NULL DEFAULT ''"}}},
	} {
		have, err := d.columns(ctx, t.table)
		if err != nil {
			return err
		}
		for _, c := range t.cols {
			if have[c.name] {
				continue
			}
			if _, err := d.sql.ExecContext(ctx, "ALTER TABLE "+t.table+" ADD COLUMN "+c.name+" "+c.ddl); err != nil {
				return fmt.Errorf("add %s.%s: %w", t.table, c.name, err)
			}
		}
	}
	return nil
}

func (d *DB) migrateV13Sessions(ctx context.Context) error {
	if err := d.addSessionColumns(ctx); err != nil {
		return err
	}
	if _, err := d.sql.ExecContext(ctx, projectSessionsSchema); err != nil {
		return fmt.Errorf("project sessions schema (v%d): %w", projectSessionsVersion, err)
	}
	if v, err := userVersion(ctx, d.sql); err != nil {
		return err
	} else if v >= projectSessionsVersion {
		return nil
	}
	return d.backfillProjectSessions(ctx)
}

// backfillProjectSessions: the existing sessions are main sessions (the column default); the newest is
// current; the orchestrator's messages and compactions are assigned to the session that held their turn;
// every sub-agent gets an agent session linked to the session and turn it was spawned in where the data
// allows, else to the session that was active when it started.
func (d *DB) backfillProjectSessions(ctx context.Context) error {
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	cur, err := ensureCurrentMain(ctx, tx)
	if err != nil {
		return err
	}
	var orchID string
	if err := tx.QueryRowContext(ctx, `SELECT id FROM agents WHERE parent_id IS NULL ORDER BY rowid LIMIT 1`).Scan(&orchID); err != nil && err != sql.ErrNoRows {
		return err
	}
	type start struct {
		turn int64
		sid  string
	}
	var starts []start
	rows, err := tx.QueryContext(ctx, `SELECT session_id, MIN(turn_id) FROM exchanges GROUP BY session_id`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var s start
		if err := rows.Scan(&s.sid, &s.turn); err != nil {
			_ = rows.Close()
			return err
		}
		starts = append(starts, s)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	sort.Slice(starts, func(i, j int) bool { return starts[i].turn < starts[j].turn })
	// sessionOf: the session whose first turn is the newest one not after id; before the first, the first.
	sessionOf := func(id int64) string {
		if len(starts) == 0 {
			return cur
		}
		out := starts[0].sid
		for _, s := range starts {
			if s.turn <= id {
				out = s.sid
			}
		}
		return out
	}
	type msg struct {
		id      int64
		role    string
		created string
	}
	var msgs []msg
	if orchID != "" {
		rows, err = tx.QueryContext(ctx, `SELECT id, role, created_at FROM messages WHERE agent_id = ? ORDER BY id`, orchID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var m msg
			if err := rows.Scan(&m.id, &m.role, &m.created); err != nil {
				_ = rows.Close()
				return err
			}
			msgs = append(msgs, m)
		}
		if err := rows.Close(); err != nil {
			return err
		}
		for _, m := range msgs {
			if _, err := tx.ExecContext(ctx, `UPDATE messages SET session_id = ? WHERE id = ? AND session_id = ''`, sessionOf(m.id), m.id); err != nil {
				return err
			}
		}
		// A regular compaction belongs to the session of the message it ends at; a clear's carry-over
		// to the session that starts after it (the one of the first message after its boundary).
		crs, err := tx.QueryContext(ctx, `SELECT id, upto_message_id, cleared FROM compactions WHERE agent_id = ? AND session_id = ''`, orchID)
		if err != nil {
			return err
		}
		type comp struct {
			id, upto int64
			cleared  bool
		}
		var comps []comp
		for crs.Next() {
			var c comp
			if err := crs.Scan(&c.id, &c.upto, &c.cleared); err != nil {
				_ = crs.Close()
				return err
			}
			comps = append(comps, c)
		}
		if err := crs.Close(); err != nil {
			return err
		}
		for _, c := range comps {
			sid := cur
			if c.cleared {
				for _, m := range msgs {
					if m.id > c.upto {
						sid = sessionOf(m.id)
						break
					}
				}
			} else if c.upto > 0 {
				sid = sessionOf(c.upto)
			}
			if _, err := tx.ExecContext(ctx, `UPDATE compactions SET session_id = ? WHERE id = ?`, sid, c.id); err != nil {
				return err
			}
		}
	}
	// Agent sessions.
	ars, err := tx.QueryContext(ctx, `SELECT id, title, model, status, created_at, COALESCE(finished_at, created_at) FROM agents
		WHERE parent_id IS NOT NULL AND id NOT IN (SELECT agent_id FROM sessions WHERE kind = 'agent')`)
	if err != nil {
		return err
	}
	type ag struct{ id, title, model, status, created, ended string }
	var agents []ag
	for ars.Next() {
		var a ag
		if err := ars.Scan(&a.id, &a.title, &a.model, &a.status, &a.created, &a.ended); err != nil {
			_ = ars.Close()
			return err
		}
		agents = append(agents, a)
	}
	if err := ars.Close(); err != nil {
		return err
	}
	for _, a := range agents {
		parent, turn := "", int64(0)
		var last, lastUser int64
		for _, m := range msgs {
			if m.created <= a.created {
				last = m.id
				if m.role == "user" {
					lastUser = m.id
				}
			}
		}
		if last != 0 {
			parent, turn = sessionOf(last), lastUser
		}
		if parent == "" {
			if err := tx.QueryRowContext(ctx, `SELECT id FROM sessions WHERE kind = 'main' AND started_at <= ? ORDER BY started_at DESC, rowid DESC LIMIT 1`, a.created).Scan(&parent); err != nil {
				// Started before the first session: it belongs to the oldest one.
				if err := tx.QueryRowContext(ctx, `SELECT id FROM sessions WHERE kind = 'main' ORDER BY started_at, rowid LIMIT 1`).Scan(&parent); err != nil {
					parent = cur
				}
			}
			turn = 0
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO sessions (id, title, started_at, ended_at, closed, reason, kind, parent_session_id, agent_id, state, model, turn_id)
			VALUES (?, ?, ?, ?, 1, '', 'agent', ?, ?, ?, ?, ?)`,
			NewID("ses"), a.title, a.created, a.ended, parent, a.id, agentSessionState(AgentStatus(a.status)), a.model, turn); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// agentSessionState maps an agent's status to the state of its session.
func agentSessionState(s AgentStatus) string {
	switch s {
	case StatusRunning:
		return SessionWorking
	case StatusFailed:
		return SessionFailed
	case StatusCancelled:
		return SessionStopped
	}
	return SessionIdle
}
