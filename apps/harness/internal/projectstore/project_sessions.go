package projectstore

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

// Session kinds and states (project sessions, schema 13).
const (
	KindMain  = "main"
	KindAgent = "agent"

	SessionWorking = "working"
	SessionWaiting = "waiting"
	SessionIdle    = "idle"
	SessionFailed  = "failed"
	SessionStopped = "stopped"
)

// ErrSessionCurrent: the session is the project's current main session, which cannot be archived or deleted.
var ErrSessionCurrent = errors.New("projectstore: the session is current")

// SessionInfo is a session of the project as the sessions API shows it. A main session is a conversation with
// the orchestrator; an agent session is the session of one sub-agent, linked to the main session whose turn
// spawned it (ParentSessionID) and to that turn (TurnID, 0 when the data did not say).
type SessionInfo struct {
	ID              string `json:"id"`
	Kind            string `json:"kind"`
	ParentSessionID string `json:"parent_session_id,omitempty"`
	AgentID         string `json:"agent_id,omitempty"`
	TurnID          int64  `json:"turn_id,omitempty"`
	Title           string `json:"title"`
	State           string `json:"state"`
	Model           string `json:"model"`
	StartedAt       string `json:"started_at"`
	LastActivityAt  string `json:"last_activity_at"`
	Exchanges       int    `json:"exchanges"`
	Children        int    `json:"children"`
	Current         bool   `json:"current"`
	Archived        bool   `json:"archived"`
	// Summary is the summary a /clear wrote when it ended a main session ("" otherwise).
	Summary string `json:"summary,omitempty"`
}

const infoSelect = `SELECT s.id, s.kind, s.parent_session_id, s.agent_id, s.turn_id, s.title, s.state,
	COALESCE(NULLIF(s.model, ''), (SELECT x.model FROM exchanges x WHERE x.session_id = s.id AND x.removed = 0 ORDER BY x.started_at DESC, x.rowid DESC LIMIT 1),
		(SELECT a.model FROM agents a WHERE a.parent_id IS NULL AND s.current = 1 LIMIT 1), ''),
	s.started_at, s.ended_at, s.current, s.archived, s.summary,
	(SELECT COUNT(*) FROM exchanges x WHERE x.session_id = s.id AND x.removed = 0),
	(SELECT COUNT(*) FROM sessions c WHERE c.parent_session_id = s.id AND c.kind = 'agent'
		AND EXISTS (SELECT 1 FROM agents a WHERE a.id = c.agent_id AND a.rewound_at IS NULL)),
	COALESCE((SELECT x.status FROM exchanges x WHERE x.session_id = s.id AND x.removed = 0 ORDER BY x.started_at DESC, x.rowid DESC LIMIT 1), '')
	FROM sessions s`

func scanInfo(sc interface{ Scan(...any) error }) (SessionInfo, error) {
	var i SessionInfo
	var last string
	if err := sc.Scan(&i.ID, &i.Kind, &i.ParentSessionID, &i.AgentID, &i.TurnID, &i.Title, &i.State, &i.Model, &i.StartedAt, &i.LastActivityAt,
		&i.Current, &i.Archived, &i.Summary, &i.Exchanges, &i.Children, &last); err != nil {
		return i, err
	}
	if i.Title == "" {
		i.Title = "New session"
	}
	if i.Kind == KindMain {
		switch last {
		case ExchangeFailed:
			i.State = SessionFailed
		case ExchangeStopped:
			i.State = SessionStopped
		default:
			i.State = SessionIdle
		}
	}
	return i, nil
}

// ensureCurrentMain returns the current main session, making one current when none is (the newest, else a
// new empty one).
func ensureCurrentMain(ctx context.Context, x txer) (string, error) {
	var sid string
	err := x.QueryRowContext(ctx, `SELECT id FROM sessions WHERE kind = 'main' AND current = 1 ORDER BY started_at DESC, rowid DESC LIMIT 1`).Scan(&sid)
	if err == nil {
		return sid, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	err = x.QueryRowContext(ctx, `SELECT id FROM sessions WHERE kind = 'main' ORDER BY started_at DESC, rowid DESC LIMIT 1`).Scan(&sid)
	switch {
	case err == nil:
		_, err = x.ExecContext(ctx, `UPDATE sessions SET current = (id = ?) WHERE kind = 'main'`, sid)
		return sid, err
	case errors.Is(err, sql.ErrNoRows):
		sid, now := NewID("ses"), Now()
		_, err = x.ExecContext(ctx, `INSERT INTO sessions (id, title, started_at, ended_at, closed, reason, current) VALUES (?, '', ?, ?, 0, '', 1)`, sid, now, now)
		return sid, err
	}
	return "", err
}

// isOrchestrator says whether the agent row is the project's root agent (unknown ids are not).
func isOrchestrator(ctx context.Context, x txer, agentID string) bool {
	var root bool
	if err := x.QueryRowContext(ctx, `SELECT parent_id IS NULL FROM agents WHERE id = ?`, agentID).Scan(&root); err != nil {
		return false
	}
	return root
}

// scopeSession is the main session the orchestrator's conversation is read from ("" for any other agent).
func (d *DB) scopeSession(ctx context.Context, agentID string) (string, error) {
	if !isOrchestrator(ctx, d.sql, agentID) {
		return "", nil
	}
	return ensureCurrentMain(ctx, d.sql)
}

// CurrentSessionID is the id of the current main session (created when the project has none yet).
func (d *DB) CurrentSessionID(ctx context.Context) (string, error) {
	return ensureCurrentMain(ctx, d.sql)
}

// SessionInfoOf returns one session; ErrNotFound when there is none.
func (d *DB) SessionInfoOf(ctx context.Context, id string) (SessionInfo, error) {
	i, err := scanInfo(d.sql.QueryRowContext(ctx, infoSelect+` WHERE s.id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return i, ErrNotFound
	}
	return i, err
}

// SessionOfAgent returns the agent session of a sub-agent; ErrNotFound when it has none.
func (d *DB) SessionOfAgent(ctx context.Context, agentID string) (SessionInfo, error) {
	i, err := scanInfo(d.sql.QueryRowContext(ctx, infoSelect+` WHERE s.kind = 'agent' AND s.agent_id = ?`, agentID))
	if errors.Is(err, sql.ErrNoRows) {
		return i, ErrNotFound
	}
	return i, err
}

// SessionFilter narrows ListSessions. Archived: "" (default) lists the sessions that are not archived, "true"
// only the archived ones, "all" both. Limit 0 means 50 (at most 200; with a State filter the caller filters
// afterwards, so no limit is applied here when Limit is negative).
type SessionFilter struct {
	Kind, Archived, Before string
	ParentID               string
	Limit                  int
}

// ListSessions lists sessions newest first (by start). A main session that holds no exchange is listed only
// while it is current; agent sessions of rewound agents are left out.
func (d *DB) ListSessions(ctx context.Context, f SessionFilter) ([]SessionInfo, error) {
	where := []string{`(s.kind = 'main' AND (s.current = 1 OR EXISTS (SELECT 1 FROM exchanges x WHERE x.session_id = s.id))
		OR s.kind = 'agent' AND EXISTS (SELECT 1 FROM agents a WHERE a.id = s.agent_id AND a.rewound_at IS NULL))`}
	var args []any
	if f.Kind == KindMain || f.Kind == KindAgent {
		where = append(where, `s.kind = ?`)
		args = append(args, f.Kind)
	}
	switch f.Archived {
	case "all":
	case "true":
		where = append(where, `s.archived = 1`)
	default:
		where = append(where, `s.archived = 0`)
	}
	if f.Before != "" {
		where = append(where, `s.started_at < ?`)
		args = append(args, f.Before)
	}
	if f.ParentID != "" {
		where = append(where, `s.parent_session_id = ?`)
		args = append(args, f.ParentID)
	}
	q := infoSelect + ` WHERE ` + strings.Join(where, ` AND `) + ` ORDER BY s.started_at DESC, s.rowid DESC`
	if f.Limit >= 0 {
		limit := f.Limit
		if limit == 0 || limit > 200 {
			limit = 50
		}
		q += ` LIMIT ?`
		args = append(args, limit)
	}
	rows, err := d.sql.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SessionInfo{}
	for rows.Next() {
		i, err := scanInfo(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, i)
	}
	return out, rows.Err()
}

// ChildSessions lists the agent sessions a main session started, oldest first.
func (d *DB) ChildSessions(ctx context.Context, parent string) ([]SessionInfo, error) {
	rows, err := d.sql.QueryContext(ctx, infoSelect+` WHERE s.kind = 'agent' AND s.parent_session_id = ?
		AND EXISTS (SELECT 1 FROM agents a WHERE a.id = s.agent_id AND a.rewound_at IS NULL) ORDER BY s.started_at, s.rowid`, parent)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SessionInfo{}
	for rows.Next() {
		i, err := scanInfo(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, i)
	}
	return out, rows.Err()
}

// SetCurrentSession makes a main session current (resume): it is reopened and unarchived. It returns the session that was current before. ErrNotFound for an unknown or agent session.
func (d *DB) SetCurrentSession(ctx context.Context, id string) (previous string, err error) {
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback() }()
	var kind string
	if err := tx.QueryRowContext(ctx, `SELECT kind FROM sessions WHERE id = ?`, id).Scan(&kind); errors.Is(err, sql.ErrNoRows) || kind != KindMain {
		return "", ErrNotFound
	} else if err != nil {
		return "", err
	}
	if previous, err = ensureCurrentMain(ctx, tx); err != nil {
		return "", err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE sessions SET current = (id = ?) WHERE kind = 'main'`, id); err != nil {
		return "", err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE sessions SET closed = 0, archived = 0 WHERE id = ?`, id); err != nil {
		return "", err
	}
	return previous, tx.Commit()
}

// PatchSession edits a session's title (the person's title is kept when the first request would rename it)
// and its archive flag. The current main session cannot be archived (ErrSessionCurrent).
func (d *DB) PatchSession(ctx context.Context, id string, title *string, archived *bool) (SessionInfo, error) {
	cur, err := d.SessionInfoOf(ctx, id)
	if err != nil {
		return cur, err
	}
	if archived != nil && *archived && cur.Current && cur.Kind == KindMain {
		return cur, ErrSessionCurrent
	}
	set := newSetter()
	if title != nil {
		set.add("title", *title)
		set.add("title_edited", 1)
	}
	if archived != nil {
		set.add("archived", *archived)
	}
	if err := set.exec(ctx, d.sql, "sessions", "id = ?", id); err != nil {
		return cur, err
	}
	return d.SessionInfoOf(ctx, id)
}

// DeleteSession removes a session: for a main session its exchanges, the orchestrator messages stored in it, its
// compaction rows and the agent sessions it started (their agents are hidden like a rewound one, their messages
// removed), all of them from the search index too. The current main session cannot be deleted
// (ErrSessionCurrent). It returns the ids of every session removed, the children first.
func (d *DB) DeleteSession(ctx context.Context, id string) ([]string, error) {
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	var kind, agentID string
	var current bool
	if err := tx.QueryRowContext(ctx, `SELECT kind, agent_id, current FROM sessions WHERE id = ?`, id).Scan(&kind, &agentID, &current); errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	} else if err != nil {
		return nil, err
	}
	if kind == KindMain && current {
		return nil, ErrSessionCurrent
	}
	removed := []string{}
	dropAgent := func(sid, aid string) error {
		rows, err := tx.QueryContext(ctx, `SELECT id FROM messages WHERE agent_id = ?`, aid)
		if err != nil {
			return err
		}
		var ids []int64
		for rows.Next() {
			var m int64
			if err := rows.Scan(&m); err != nil {
				_ = rows.Close()
				return err
			}
			ids = append(ids, m)
		}
		if err := rows.Close(); err != nil {
			return err
		}
		for _, m := range ids {
			if err := delDoc(ctx, tx, DocMessage, itoa(m)); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM messages WHERE agent_id = ?`, aid); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE agents SET rewound_at = ? WHERE id = ? AND rewound_at IS NULL`, Now(), aid); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE id = ?`, sid); err != nil {
			return err
		}
		removed = append(removed, sid)
		return nil
	}
	if kind == KindAgent {
		if err := dropAgent(id, agentID); err != nil {
			return nil, err
		}
		return removed, tx.Commit()
	}
	crows, err := tx.QueryContext(ctx, `SELECT id, agent_id FROM sessions WHERE kind = 'agent' AND parent_session_id = ?`, id)
	if err != nil {
		return nil, err
	}
	type child struct{ sid, aid string }
	var kids []child
	for crows.Next() {
		var c child
		if err := crows.Scan(&c.sid, &c.aid); err != nil {
			_ = crows.Close()
			return nil, err
		}
		kids = append(kids, c)
	}
	if err := crows.Close(); err != nil {
		return nil, err
	}
	for _, c := range kids {
		if err := dropAgent(c.sid, c.aid); err != nil {
			return nil, err
		}
	}
	exs, err := tx.QueryContext(ctx, `SELECT id FROM exchanges WHERE session_id = ?`, id)
	if err != nil {
		return nil, err
	}
	var exIDs []string
	for exs.Next() {
		var e string
		if err := exs.Scan(&e); err != nil {
			_ = exs.Close()
			return nil, err
		}
		exIDs = append(exIDs, e)
	}
	if err := exs.Close(); err != nil {
		return nil, err
	}
	for _, e := range exIDs {
		if err := delDoc(ctx, tx, DocExchange, e); err != nil {
			return nil, err
		}
	}
	mrows, err := tx.QueryContext(ctx, `SELECT id FROM messages WHERE session_id = ?`, id)
	if err != nil {
		return nil, err
	}
	var msgIDs []int64
	for mrows.Next() {
		var m int64
		if err := mrows.Scan(&m); err != nil {
			_ = mrows.Close()
			return nil, err
		}
		msgIDs = append(msgIDs, m)
	}
	if err := mrows.Close(); err != nil {
		return nil, err
	}
	for _, m := range msgIDs {
		if err := delDoc(ctx, tx, DocMessage, itoa(m)); err != nil {
			return nil, err
		}
	}
	for _, q := range []string{
		`DELETE FROM exchanges WHERE session_id = ?`, `DELETE FROM messages WHERE session_id = ?`,
		`DELETE FROM compactions WHERE session_id = ?`, `DELETE FROM session_reports WHERE session_id = ?`,
		`DELETE FROM sessions WHERE id = ?`,
	} {
		if _, err := tx.ExecContext(ctx, q, id); err != nil {
			return nil, err
		}
	}
	return append(removed, id), tx.Commit()
}

// CreateAgentSession records the session of a sub-agent, linked to the main session whose turn spawned it.
func (d *DB) CreateAgentSession(ctx context.Context, a Agent, parent string, turnID int64) (SessionInfo, error) {
	if parent == "" {
		var err error
		if parent, err = ensureCurrentMain(ctx, d.sql); err != nil {
			return SessionInfo{}, err
		}
	}
	id := NewID("ses")
	end := a.CreatedAt
	if a.FinishedAt != nil {
		end = *a.FinishedAt
	}
	if _, err := d.sql.ExecContext(ctx, `INSERT INTO sessions (id, title, started_at, ended_at, closed, reason, kind, parent_session_id, agent_id, state, model, turn_id)
		VALUES (?, ?, ?, ?, 1, '', 'agent', ?, ?, ?, ?, ?)`,
		id, a.Title, a.CreatedAt, end, parent, a.ID, agentSessionState(a.Status), a.Model, turnID); err != nil {
		return SessionInfo{}, err
	}
	return d.SessionInfoOf(ctx, id)
}

// syncAgentSession mirrors an agent's status and model on its session.
func (d *DB) syncAgentSession(ctx context.Context, id string) {
	a, err := d.Agent(ctx, id)
	if err != nil || a.ParentID == nil {
		return
	}
	end := Now()
	if a.FinishedAt != nil {
		end = *a.FinishedAt
	}
	_, _ = d.sql.ExecContext(ctx, `UPDATE sessions SET state = ?, model = ?, ended_at = ? WHERE kind = 'agent' AND agent_id = ?`,
		agentSessionState(a.Status), a.Model, end, id)
}

// SessionMessages returns the messages of a session: for a main session the orchestrator messages stored in
// it (rewound ones left out), for an agent session the agent's own.
func (d *DB) SessionMessages(ctx context.Context, id string) ([]Message, error) {
	info, err := d.SessionInfoOf(ctx, id)
	if err != nil {
		return nil, err
	}
	if info.Kind == KindAgent {
		return d.Messages(ctx, info.AgentID)
	}
	orch, err := d.Orchestrator(ctx)
	if err != nil {
		return nil, err
	}
	all, err := d.Messages(ctx, orch.ID)
	if err != nil {
		return nil, err
	}
	out := all[:0:0]
	for _, m := range all {
		if m.SessionID == id {
			out = append(out, m)
		}
	}
	return out, nil
}

// SessionACP is the ACP session an agent kept for a session.
type SessionACP struct{ Agent, Model, SessionID string }

// SetSessionACP remembers the ACP session an agent opened for a session (resume uses session/load with it).
func (d *DB) SetSessionACP(ctx context.Context, id string, a SessionACP) error {
	_, err := d.sql.ExecContext(ctx, `UPDATE sessions SET acp_agent = ?, acp_model = ?, acp_session_id = ? WHERE id = ?`, a.Agent, a.Model, a.SessionID, id)
	return err
}

// SessionACPOf returns the ACP session kept for a session (ok false when none).
func (d *DB) SessionACPOf(ctx context.Context, id string) (SessionACP, bool, error) {
	var a SessionACP
	err := d.sql.QueryRowContext(ctx, `SELECT acp_agent, acp_model, acp_session_id FROM sessions WHERE id = ?`, id).Scan(&a.Agent, &a.Model, &a.SessionID)
	if errors.Is(err, sql.ErrNoRows) {
		return a, false, nil
	}
	return a, err == nil && a.SessionID != "", err
}

// SessionReport is a note an agent session's answer left for the orchestrator.
type SessionReport struct {
	ID            int64
	FromSessionID string
	Text          string
	CreatedAt     string
}

// AddSessionReport queues a note for the orchestrator of a main session: it is handed over at that session's next turn.
func (d *DB) AddSessionReport(ctx context.Context, mainSession, fromSession, text string) error {
	_, err := d.sql.ExecContext(ctx, `INSERT INTO session_reports (session_id, from_session_id, text, created_at) VALUES (?,?,?,?)`, mainSession, fromSession, text, Now())
	return err
}

// TakeSessionReports returns the undelivered notes of a main session, oldest first, and marks them delivered.
func (d *DB) TakeSessionReports(ctx context.Context, mainSession string) ([]SessionReport, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT id, from_session_id, text, created_at FROM session_reports WHERE session_id = ? AND delivered_at IS NULL ORDER BY id`, mainSession)
	if err != nil {
		return nil, err
	}
	var out []SessionReport
	for rows.Next() {
		var r SessionReport
		if err := rows.Scan(&r.ID, &r.FromSessionID, &r.Text, &r.CreatedAt); err != nil {
			_ = rows.Close()
			return nil, err
		}
		out = append(out, r)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for _, r := range out {
		if _, err := d.sql.ExecContext(ctx, `UPDATE session_reports SET delivered_at = ? WHERE id = ?`, Now(), r.ID); err != nil {
			return nil, err
		}
	}
	return out, nil
}
