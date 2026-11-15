package projectstore

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

// Session kinds and states (project sessions, schema 13; queued: schema 15).
const (
	KindMain  = "main"
	KindAgent = "agent"

	SessionWorking = "working"
	SessionWaiting = "waiting"
	SessionQueued  = "queued"
	SessionIdle    = "idle"
	SessionFailed  = "failed"
	SessionStopped = "stopped"
)

// Memory modes of a main session (schema 15; only "on" changes behaviour before memory modes are built).
const (
	MemoryOn   = "on"
	MemoryRead = "read"
	MemoryOff  = "off"
)

// ValidMemoryMode reports whether m is a memory mode.
func ValidMemoryMode(m string) bool { return m == MemoryOn || m == MemoryRead || m == MemoryOff }

// ErrSessionCurrent: the session is the project's default (formerly "current") main session, which cannot be
// archived or deleted.
var ErrSessionCurrent = errors.New("projectstore: the session is the default")

// SessionWorkspace names the workspace a main session's files are in (schema 15: always the shared one until
// worktrees are built).
type SessionWorkspace struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"`
	Title  string `json:"title"`
	Branch string `json:"branch,omitempty"`
}

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
	// Default: the main session that takes what is sent to the project without a session. Current is its old
	// name, kept with the same value for one release.
	Default  bool `json:"default"`
	Current  bool `json:"current"`
	Archived bool `json:"archived"`
	// Summary is the summary a /clear wrote when it ended a main session ("" otherwise).
	Summary string `json:"summary,omitempty"`
	// Main sessions (schema 15): the root agent that runs it ("" until its first turn for a session made before
	// schema 15 without messages), its workspace, memory mode, mode ("": the project's) and queue.
	RootAgentID     string            `json:"root_agent_id,omitempty"`
	Workspace       *SessionWorkspace `json:"workspace,omitempty"`
	Memory          string            `json:"memory,omitempty"`
	MemoryInherited bool              `json:"memory_inherited,omitempty"`
	Mode            string            `json:"mode"`
	Queued          int               `json:"queued"`
	QueuePaused     bool              `json:"queue_paused"`
}

const infoSelect = `SELECT s.id, s.kind, s.parent_session_id, s.agent_id, s.turn_id, s.title, s.state,
	COALESCE(NULLIF(s.model, ''), (SELECT x.model FROM exchanges x WHERE x.session_id = s.id AND x.removed = 0 ORDER BY x.started_at DESC, x.rowid DESC LIMIT 1),
		(SELECT a.model FROM agents a WHERE a.id = s.root_agent_id), ''),
	s.started_at, s.ended_at, s.current, s.archived, s.summary,
	(SELECT COUNT(*) FROM exchanges x WHERE x.session_id = s.id AND x.removed = 0),
	(SELECT COUNT(*) FROM sessions c WHERE c.parent_session_id = s.id AND c.kind = 'agent'
		AND EXISTS (SELECT 1 FROM agents a WHERE a.id = c.agent_id AND a.rewound_at IS NULL)),
	COALESCE((SELECT x.status FROM exchanges x WHERE x.session_id = s.id AND x.removed = 0 ORDER BY x.started_at DESC, x.rowid DESC LIMIT 1), ''),
	s.root_agent_id, s.workspace_id, s.memory_mode, s.mode, s.queue_paused, (SELECT COUNT(*) FROM queue q WHERE q.session_id = s.id)
	FROM sessions s`

func scanInfo(sc interface{ Scan(...any) error }) (SessionInfo, error) {
	var i SessionInfo
	var last, workspace string
	if err := sc.Scan(&i.ID, &i.Kind, &i.ParentSessionID, &i.AgentID, &i.TurnID, &i.Title, &i.State, &i.Model, &i.StartedAt, &i.LastActivityAt,
		&i.Current, &i.Archived, &i.Summary, &i.Exchanges, &i.Children, &last,
		&i.RootAgentID, &workspace, &i.Memory, &i.Mode, &i.QueuePaused, &i.Queued); err != nil {
		return i, err
	}
	if i.Title == "" {
		i.Title = "New session"
	}
	i.Default = i.Current
	if i.Kind == KindMain {
		switch last {
		case ExchangeFailed:
			i.State = SessionFailed
		case ExchangeStopped:
			i.State = SessionStopped
		default:
			i.State = SessionIdle
		}
		if workspace == "" {
			workspace = SharedWorkspace
		}
		i.Workspace = &SessionWorkspace{ID: workspace, Kind: "shared", Title: "Main checkout"}
		if i.Memory == "" {
			i.Memory = MemoryOn
		}
		// Every project's default for new sessions is "on" until memory modes are built (spec section 5).
		i.MemoryInherited = i.Memory == MemoryOn
	} else {
		i.Memory, i.Mode, i.RootAgentID = "", "", ""
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

// isOrchestrator says whether the agent row is a root agent (unknown ids are not).
func isOrchestrator(ctx context.Context, x txer, agentID string) bool {
	var root bool
	if err := x.QueryRowContext(ctx, `SELECT parent_id IS NULL FROM agents WHERE id = ?`, agentID).Scan(&root); err != nil {
		return false
	}
	return root
}

// sessionOfRoot is the main session a root agent runs (schema 15), else the default session (a root that was
// never linked: a database written before the back-fill could link it).
func sessionOfRoot(ctx context.Context, x txer, agentID string) (string, error) {
	var sid string
	err := x.QueryRowContext(ctx, `SELECT id FROM sessions WHERE kind = 'main' AND root_agent_id = ? ORDER BY rowid LIMIT 1`, agentID).Scan(&sid)
	if err == nil {
		return sid, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	return ensureCurrentMain(ctx, x)
}

// scopeSession is the main session a root agent's conversation is read from ("" for any other agent).
func (d *DB) scopeSession(ctx context.Context, agentID string) (string, error) {
	if !isOrchestrator(ctx, d.sql, agentID) {
		return "", nil
	}
	return sessionOfRoot(ctx, d.sql, agentID)
}

// CurrentSessionID is the id of the default main session (created when the project has none yet).
func (d *DB) CurrentSessionID(ctx context.Context) (string, error) {
	return ensureCurrentMain(ctx, d.sql)
}

// DefaultSessionID is CurrentSessionID under its schema-15 name.
func (d *DB) DefaultSessionID(ctx context.Context) (string, error) {
	return ensureCurrentMain(ctx, d.sql)
}

// SessionOfAgentRow is the main session an agent works in (agents.session_id; the default for an agent that has none).
func (d *DB) SessionOfAgentRow(ctx context.Context, agentID string) (string, error) {
	var sid string
	err := d.sql.QueryRowContext(ctx, `SELECT session_id FROM agents WHERE id = ?`, agentID).Scan(&sid)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	if sid == "" {
		return ensureCurrentMain(ctx, d.sql)
	}
	return sid, nil
}

// RootAgent returns the root agent of a main session ("": the default session). A session that has none yet (made
// before schema 15 and never run) gets one now, copied from the default's root (role, model, tier). ErrNotFound
// for an unknown or agent session.
func (d *DB) RootAgent(ctx context.Context, sid string) (Agent, error) {
	if sid == "" {
		var err error
		if sid, err = ensureCurrentMain(ctx, d.sql); err != nil {
			return Agent{}, err
		}
	}
	var kind, root string
	err := d.sql.QueryRowContext(ctx, `SELECT kind, root_agent_id FROM sessions WHERE id = ?`, sid).Scan(&kind, &root)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && kind != KindMain) {
		return Agent{}, ErrNotFound
	}
	if err != nil {
		return Agent{}, err
	}
	if root != "" {
		a, err := d.Agent(ctx, root)
		if err == nil || !errors.Is(err, ErrNotFound) {
			return a, err
		}
	}
	return d.linkRoot(ctx, sid)
}

// linkRoot gives a main session its root agent: the project's only unlinked root when there is one (a database
// whose orchestrator was created before the session existed), else a new row copied from another root.
func (d *DB) linkRoot(ctx context.Context, sid string) (Agent, error) {
	var id string
	err := d.sql.QueryRowContext(ctx, `SELECT a.id FROM agents a WHERE a.parent_id IS NULL AND a.session_id = ''
		AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.root_agent_id = a.id) ORDER BY a.rowid LIMIT 1`).Scan(&id)
	switch {
	case err == nil:
	case errors.Is(err, sql.ErrNoRows):
		var role, model string
		var tier sql.NullString
		if err := d.sql.QueryRowContext(ctx, `SELECT role, model, tier FROM agents WHERE parent_id IS NULL ORDER BY rowid LIMIT 1`).Scan(&role, &model, &tier); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				role = OrchestratorRole
			} else {
				return Agent{}, err
			}
		}
		var t *Tier
		if tier.Valid {
			v := Tier(tier.String)
			t = &v
		}
		a, err := d.CreateAgent(ctx, NewAgent{Role: role, Model: model, Tier: t, Status: StatusIdle, SessionID: sid})
		if err != nil {
			return Agent{}, err
		}
		id = a.ID
	default:
		return Agent{}, err
	}
	if _, err := d.sql.ExecContext(ctx, `UPDATE agents SET session_id = ? WHERE id = ?`, sid, id); err != nil {
		return Agent{}, err
	}
	if _, err := d.sql.ExecContext(ctx, `UPDATE sessions SET root_agent_id = ? WHERE id = ?`, id, sid); err != nil {
		return Agent{}, err
	}
	return d.Agent(ctx, id)
}

// NewMainSession is what POST /sessions creates: a main session with its own root agent (model copied from the
// default's root unless given), in the shared workspace, made the default only with makeDefault. It returns the
// session and the one that was the default before ("" when it did not change).
type NewMainSession struct {
	Title       string
	Model       string
	Mode        string
	Memory      string
	WorkspaceID string
	MakeDefault bool
}

// CreateMainSession creates a main session (see NewMainSession).
func (d *DB) CreateMainSession(ctx context.Context, in NewMainSession) (info SessionInfo, previous string, err error) {
	def, err := d.RootAgent(ctx, "")
	if err != nil {
		return SessionInfo{}, "", err
	}
	model := in.Model
	if model == "" {
		model = def.Model
	}
	memory := in.Memory
	if !ValidMemoryMode(memory) {
		memory = MemoryOn
	}
	ws := in.WorkspaceID
	if ws == "" {
		ws = SharedWorkspace
	}
	sid, now := NewID("ses"), Now()
	titled := 0
	if in.Title != "" {
		titled = 1
	}
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return SessionInfo{}, "", err
	}
	defer func() { _ = tx.Rollback() }()
	cur, err := ensureCurrentMain(ctx, tx)
	if err != nil {
		return SessionInfo{}, "", err
	}
	root := NewID("agt")
	if _, err := tx.ExecContext(ctx, `INSERT INTO agents (id, parent_id, depth, role, title, task, model, tier, status, created_at, session_id)
		VALUES (?, NULL, 0, ?, ?, '', ?, ?, 'idle', ?, ?)`, root, def.Role, def.Title, model, tierValue(def.Tier), now, sid); err != nil {
		return SessionInfo{}, "", err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO sessions (id, title, started_at, ended_at, closed, reason, kind, current, title_edited,
		workspace_id, memory_mode, mode, root_agent_id, model) VALUES (?, ?, ?, ?, 0, '', 'main', 0, ?, ?, ?, ?, ?, ?)`,
		sid, in.Title, now, now, titled, ws, memory, in.Mode, root, in.Model); err != nil {
		return SessionInfo{}, "", err
	}
	if in.MakeDefault {
		if _, err := tx.ExecContext(ctx, `UPDATE sessions SET current = (id = ?) WHERE kind = 'main'`, sid); err != nil {
			return SessionInfo{}, "", err
		}
		previous = cur
	}
	if err := tx.Commit(); err != nil {
		return SessionInfo{}, "", err
	}
	if err := d.Touch(ctx); err != nil {
		return SessionInfo{}, "", err
	}
	info, err = d.SessionInfoOf(ctx, sid)
	return info, previous, err
}

func tierValue(t *Tier) any {
	if t == nil {
		return nil
	}
	return string(*t)
}

// SetSessionSettings changes what a main session runs with from its next turn: model ("" keeps it; sessions.model),
// mode ("" is the project's; nil keeps it) and memory mode (nil keeps it).
func (d *DB) SetSessionSettings(ctx context.Context, sid string, model string, mode, memory *string) error {
	set := newSetter()
	if mode != nil {
		set.add("mode", *mode)
	}
	if memory != nil {
		set.add("memory_mode", *memory)
	}
	if mode != nil || memory != nil {
		if err := set.exec(ctx, d.sql, "sessions", "id = ? AND kind = 'main'", sid); err != nil {
			return err
		}
	}
	if model != "" {
		if _, err := d.sql.ExecContext(ctx, `UPDATE sessions SET model = ? WHERE id = ? AND kind = 'main'`, model, sid); err != nil {
			return err
		}
	}
	return nil
}

// SessionModel is the orchestrator model chosen for a main session ("": the project's).
func (d *DB) SessionModel(ctx context.Context, sid string) (model, mode string, err error) {
	err = d.sql.QueryRowContext(ctx, `SELECT model, mode FROM sessions WHERE id = ? AND kind = 'main'`, sid).Scan(&model, &mode)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", ErrNotFound
	}
	return model, mode, err
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

// ListSessions lists sessions newest first (by start). A main session that holds no exchange is listed while it
// is the default or has a root agent (it was made addressable: schema 15); agent sessions of rewound agents are
// left out.
func (d *DB) ListSessions(ctx context.Context, f SessionFilter) ([]SessionInfo, error) {
	where := []string{`(s.kind = 'main' AND (s.current = 1 OR s.root_agent_id != '' OR EXISTS (SELECT 1 FROM exchanges x WHERE x.session_id = s.id))
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

// UnarchiveSession takes a main session out of the archive (a message sent to it does).
func (d *DB) UnarchiveSession(ctx context.Context, id string) error {
	_, err := d.sql.ExecContext(ctx, `UPDATE sessions SET archived = 0 WHERE id = ? AND archived = 1`, id)
	return err
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

// ShouldAutoNameSession reports whether id is a main session on its first exchange whose title was not
// manually edited by the user.
func (d *DB) ShouldAutoNameSession(ctx context.Context, id string) (bool, error) {
	if id == "" {
		return false, nil
	}
	var kind string
	var edited bool
	var exchanges int
	err := d.sql.QueryRowContext(ctx, `SELECT s.kind, s.title_edited,
		(SELECT COUNT(*) FROM exchanges e WHERE e.session_id = s.id AND e.removed = 0)
		FROM sessions s WHERE s.id = ?`, id).Scan(&kind, &edited, &exchanges)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return kind == KindMain && !edited && exchanges <= 1, nil
}

// SetAutoSessionTitle sets a session's title only if it has not been manually edited (title_edited = 0).
// It returns whether a row was updated.
func (d *DB) SetAutoSessionTitle(ctx context.Context, id, title string) (bool, error) {
	title = strings.TrimSpace(title)
	if id == "" || title == "" {
		return false, nil
	}
	res, err := d.sql.ExecContext(ctx, `UPDATE sessions SET title = ? WHERE id = ? AND title_edited = 0`, title, id)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
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
	// The session's own root agent is hidden like a rewound one (its messages go with the session's).
	if _, err := tx.ExecContext(ctx, `UPDATE agents SET rewound_at = ? WHERE id = (SELECT root_agent_id FROM sessions WHERE id = ?)
		AND rewound_at IS NULL AND NOT EXISTS (SELECT 1 FROM sessions o WHERE o.id != ? AND o.root_agent_id = agents.id)`, Now(), id, id); err != nil {
		return nil, err
	}
	for _, q := range []string{
		`DELETE FROM exchanges WHERE session_id = ?`, `DELETE FROM messages WHERE session_id = ?`,
		`DELETE FROM compactions WHERE session_id = ?`, `DELETE FROM session_reports WHERE session_id = ?`,
		`DELETE FROM queue WHERE session_id = ?`, `DELETE FROM sessions WHERE id = ?`,
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
	if info.RootAgentID == "" {
		return []Message{}, nil // never ran since schema 15 and held no messages before it
	}
	all, err := d.Messages(ctx, info.RootAgentID)
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
