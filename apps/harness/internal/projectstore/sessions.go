package projectstore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// DocExchange is the kind of the search document of an exchange.
const DocExchange = "exchange"

// Exchange statuses.
const (
	ExchangeCompleted = "completed"
	ExchangeFailed    = "failed"
	ExchangeStopped   = "stopped"
)

// Session is a run of exchanges in one conversation. Reason says why it ended
// ("clear", "rewind"); empty while it is open or when it just went quiet.
type Session struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	StartedAt string `json:"started_at"`
	EndedAt   string `json:"ended_at"`
	Exchanges int    `json:"exchanges"`
	Open      bool   `json:"open"`
	Reason    string `json:"reason,omitempty"`
	// Summary is the summary a /clear wrote when it ended the session (SummarySource: "model", "agent" or "stored");
	// empty for a session that ended any other way.
	Summary       string `json:"summary,omitempty"`
	SummarySource string `json:"summary_source,omitempty"`
}

// Tokens is the input and output a turn used.
type Tokens struct {
	Input  int64 `json:"input"`
	Output int64 `json:"output"`
}

// Exchange is one request and its answer. TurnID is the user message that
// started the turn, MessageID the assistant message that answered (0 when
// none). A forgotten exchange stays as a marker (Removed) with its texts gone.
type Exchange struct {
	ID              string   `json:"id"`
	SessionID       string   `json:"session_id,omitempty"`
	TurnID          int64    `json:"turn_id"`
	MessageID       int64    `json:"message_id"`
	Request         string   `json:"request"`
	Answer          string   `json:"answer"`
	AnswerTruncated bool     `json:"answer_truncated"`
	Status          string   `json:"status"`
	StartedAt       string   `json:"started_at"`
	DurationMS      int64    `json:"duration_ms"`
	Model           string   `json:"model"`
	Files           []string `json:"files"`
	Agents          []string `json:"agents"`
	Tokens          Tokens   `json:"tokens"`
	CostUSD         *float64 `json:"cost_usd"`
	TaskID          string   `json:"task_id,omitempty"`
	Removed         bool     `json:"removed,omitempty"`
}

const exchangeCols = `id, session_id, turn_id, message_id, request, answer, answer_truncated, status, started_at, duration_ms, model,
	files_json, agents_json, input_tokens, output_tokens, cost_usd, task_id, removed`

func scanExchange(sc interface{ Scan(...any) error }) (Exchange, error) {
	var e Exchange
	var files, agents string
	var cost sql.NullFloat64
	if err := sc.Scan(&e.ID, &e.SessionID, &e.TurnID, &e.MessageID, &e.Request, &e.Answer, &e.AnswerTruncated, &e.Status, &e.StartedAt,
		&e.DurationMS, &e.Model, &files, &agents, &e.Tokens.Input, &e.Tokens.Output, &cost, &e.TaskID, &e.Removed); err != nil {
		return e, err
	}
	_ = json.Unmarshal([]byte(files), &e.Files)
	_ = json.Unmarshal([]byte(agents), &e.Agents)
	if e.Files == nil {
		e.Files = []string{}
	}
	if e.Agents == nil {
		e.Agents = []string{}
	}
	if cost.Valid {
		v := cost.Float64
		e.CostUSD = &v
	}
	return e, nil
}

// SessionTitle is the first line of a request, trimmed to 80 characters.
func SessionTitle(request string) string {
	line := strings.TrimSpace(request)
	if i := strings.IndexAny(line, "\r\n"); i >= 0 {
		line = strings.TrimSpace(line[:i])
	}
	if r := []rune(line); len(r) > 80 {
		line = string(r[:80])
	}
	if line == "" {
		return "Session"
	}
	return line
}

func exchangeDoc(e Exchange, redact func(string) string) Doc {
	return Doc{Kind: DocExchange, Ref: e.ID, Title: redact(SessionTitle(e.Request)), Body: redact(e.Request + "\n" + e.Answer),
		Date: e.StartedAt, MessageID: e.TurnID, TaskID: e.TaskID}
}

func parseStamp(s string) time.Time {
	t, _ := time.Parse(time.RFC3339Nano, s)
	return t
}

type txer interface {
	execer
	QueryRowContext(ctx context.Context, q string, args ...any) *sql.Row
}

// RecordExchange stores the exchange of a finished turn, once: a turn recorded
// again (the retry of a failed one) replaces its record in place, except that a
// forgotten exchange stays forgotten. The exchange joins the latest session
// unless that is closed or ended more than gap before this one started; then
// it opens a new one. The caller redacts the texts; the index is redacted again
// by the store's redactor.
func (d *DB) RecordExchange(ctx context.Context, e Exchange, gap time.Duration) (Exchange, Session, error) {
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return e, Session{}, err
	}
	defer func() { _ = tx.Rollback() }()
	e, s, err := recordExchange(ctx, tx, e, gap, d.scrub)
	if err != nil {
		return e, s, err
	}
	return e, s, tx.Commit()
}

func recordExchange(ctx context.Context, tx txer, e Exchange, gap time.Duration, redact func(string) string) (Exchange, Session, error) {
	if e.Files == nil {
		e.Files = []string{}
	}
	if e.Agents == nil {
		e.Agents = []string{}
	}
	files, _ := json.Marshal(e.Files)
	agents, _ := json.Marshal(e.Agents)
	var cost any
	if e.CostUSD != nil {
		cost = *e.CostUSD
	}
	end := Stamp(parseStamp(e.StartedAt).Add(time.Duration(e.DurationMS) * time.Millisecond))
	var id, sid string
	var removed bool
	err := tx.QueryRowContext(ctx, `SELECT id, session_id, removed FROM exchanges WHERE turn_id = ?`, e.TurnID).Scan(&id, &sid, &removed)
	switch {
	case err == nil && removed:
		s, err := loadSession(ctx, tx, sid)
		return e, s, err
	case err == nil:
		e.ID, e.SessionID = id, sid
		if _, err := tx.ExecContext(ctx, `UPDATE exchanges SET message_id=?, request=?, answer=?, answer_truncated=?, status=?, started_at=?, duration_ms=?,
			model=?, files_json=?, agents_json=?, input_tokens=?, output_tokens=?, cost_usd=?, task_id=? WHERE id=?`,
			e.MessageID, e.Request, e.Answer, e.AnswerTruncated, e.Status, e.StartedAt, e.DurationMS, e.Model, string(files), string(agents),
			e.Tokens.Input, e.Tokens.Output, cost, e.TaskID, id); err != nil {
			return e, Session{}, err
		}
	case errors.Is(err, sql.ErrNoRows):
		sid, err = pickSession(ctx, tx, e, gap)
		if err != nil {
			return e, Session{}, err
		}
		e.ID, e.SessionID = NewID("exc"), sid
		if _, err := tx.ExecContext(ctx, `INSERT INTO exchanges (`+exchangeCols+`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
			e.ID, sid, e.TurnID, e.MessageID, e.Request, e.Answer, e.AnswerTruncated, e.Status, e.StartedAt, e.DurationMS, e.Model,
			string(files), string(agents), e.Tokens.Input, e.Tokens.Output, cost, e.TaskID); err != nil {
			return e, Session{}, err
		}
	default:
		return e, Session{}, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE sessions SET ended_at = MAX(ended_at, ?) WHERE id = ?`, end, sid); err != nil {
		return e, Session{}, err
	}
	if err := putDoc(ctx, tx, exchangeDoc(e, redact)); err != nil {
		return e, Session{}, err
	}
	s, err := loadSession(ctx, tx, sid)
	return e, s, err
}

func pickSession(ctx context.Context, tx txer, e Exchange, gap time.Duration) (string, error) {
	// The turn's own session: the one its user message was stored in (project sessions, schema 13).
	var own string
	if err := tx.QueryRowContext(ctx, `SELECT s.id FROM messages m JOIN sessions s ON s.id = m.session_id WHERE m.id = ? AND s.kind = 'main'`, e.TurnID).Scan(&own); err == nil && own != "" {
		var held int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM exchanges WHERE session_id = ?`, own).Scan(&held); err != nil {
			return "", err
		}
		if held == 0 {
			return own, nameSession(ctx, tx, own, e)
		}
		return own, nil
	}
	var sid, ended string
	var closed bool
	var held int
	err := tx.QueryRowContext(ctx, `SELECT id, ended_at, closed, (SELECT COUNT(*) FROM exchanges x WHERE x.session_id = sessions.id)
		FROM sessions WHERE kind = 'main' ORDER BY current DESC, started_at DESC, rowid DESC LIMIT 1`).Scan(&sid, &ended, &closed, &held)
	if err == nil && !closed && held == 0 {
		// A boundary (/clear) left an empty session open for this request: it names and dates the session.
		return sid, nameSession(ctx, tx, sid, e)
	}
	if err == nil && !closed && parseStamp(e.StartedAt).Sub(parseStamp(ended)) <= gap {
		return sid, nil
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	sid = NewID("ses")
	if _, err = tx.ExecContext(ctx, `UPDATE sessions SET current = 0 WHERE kind = 'main'`); err != nil {
		return "", err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO sessions (id, title, started_at, ended_at, closed, reason, current) VALUES (?,?,?,?,0,'',1)`,
		sid, SessionTitle(e.Request), e.StartedAt, e.StartedAt)
	return sid, err
}

// nameSession titles and dates an empty session by its first request; a title the person set stays.
func nameSession(ctx context.Context, tx txer, sid string, e Exchange) error {
	_, err := tx.ExecContext(ctx, `UPDATE sessions SET title = CASE WHEN title_edited = 1 THEN title ELSE ? END, started_at = ?, ended_at = ? WHERE id = ?`,
		SessionTitle(e.Request), e.StartedAt, e.StartedAt, sid)
	return err
}

type rower interface {
	QueryRowContext(ctx context.Context, q string, args ...any) *sql.Row
}

func loadSession(ctx context.Context, x rower, id string) (Session, error) {
	var s Session
	var closed bool
	err := x.QueryRowContext(ctx, `SELECT s.id, s.title, s.started_at, s.ended_at, s.closed, s.reason, s.summary, s.summary_source,
		(SELECT COUNT(*) FROM exchanges e WHERE e.session_id = s.id AND e.removed = 0),
		s.current = 1
		FROM sessions s WHERE s.id = ?`, id).Scan(&s.ID, &s.Title, &s.StartedAt, &s.EndedAt, &closed, &s.Reason, &s.Summary, &s.SummarySource, &s.Exchanges, &s.Open)
	if errors.Is(err, sql.ErrNoRows) {
		return s, ErrNotFound
	}
	s.Open = s.Open && !closed
	if s.Title == "" {
		s.Title = "New session"
	}
	return s, err
}

// CloseSession ends the latest session (the next exchange starts a new one),
// recording why ("clear", "rewind"). It does nothing when there is none or it
// is already closed.
func (d *DB) CloseSession(ctx context.Context, reason string) error {
	_, err := d.sql.ExecContext(ctx, `UPDATE sessions SET closed = 1, reason = ? WHERE closed = 0 AND id =
		(SELECT id FROM sessions WHERE kind = 'main' ORDER BY current DESC, started_at DESC, rowid DESC LIMIT 1)`, reason)
	return err
}

// StartNewSession is the boundary of /clear (and of a rewind that cut every request): it ends the latest
// session, recording the reason and the summary that was carried over, and opens an empty session the next
// exchange joins and names. It answers the id of the session that ended ("" when the project had none) and
// of the new one. It is idempotent: with an empty session already open it changes nothing, and previous is
// then the newest session before it that holds an exchange.
func (d *DB) StartNewSession(ctx context.Context, reason, summary, source string, now time.Time) (previous, current string, err error) {
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return "", "", err
	}
	defer func() { _ = tx.Rollback() }()
	var sid string
	var closed bool
	var held int
	err = tx.QueryRowContext(ctx, `SELECT id, closed, (SELECT COUNT(*) FROM exchanges x WHERE x.session_id = sessions.id)
		FROM sessions WHERE kind = 'main' ORDER BY current DESC, started_at DESC, rowid DESC LIMIT 1`).Scan(&sid, &closed, &held)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		// Nothing ran yet.
	case err != nil:
		return "", "", err
	case !closed && held == 0:
		current = sid
		if _, err := tx.ExecContext(ctx, `UPDATE sessions SET current = (id = ?) WHERE kind = 'main'`, sid); err != nil {
			return "", "", err
		}
		err = tx.QueryRowContext(ctx, `SELECT s.id FROM sessions s WHERE s.id != ? AND EXISTS (SELECT 1 FROM exchanges e WHERE e.session_id = s.id)
			ORDER BY s.started_at DESC, s.rowid DESC LIMIT 1`, sid).Scan(&previous)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return "", "", err
		}
		return previous, current, tx.Commit()
	default:
		previous = sid
		if _, err := tx.ExecContext(ctx, `UPDATE sessions SET closed = 1, reason = CASE WHEN closed = 0 THEN ? ELSE reason END,
			summary = CASE WHEN summary = '' THEN ? ELSE summary END, summary_source = CASE WHEN summary = '' THEN ? ELSE summary_source END WHERE id = ?`,
			reason, summary, source, sid); err != nil {
			return "", "", err
		}
	}
	current = NewID("ses")
	at := Stamp(now)
	if _, err := tx.ExecContext(ctx, `UPDATE sessions SET current = 0 WHERE kind = 'main'`); err != nil {
		return "", "", err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO sessions (id, title, started_at, ended_at, closed, reason, current) VALUES (?, '', ?, ?, 0, '', 1)`, current, at, at); err != nil {
		return "", "", err
	}
	return previous, current, tx.Commit()
}

// Sessions lists sessions newest first; before (a started_at) pages.
func (d *DB) Sessions(ctx context.Context, limit int, before string) ([]Session, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	// A session a boundary left open and empty is not listed until its first request.
	q, args := `SELECT id FROM sessions WHERE kind = 'main' AND EXISTS (SELECT 1 FROM exchanges x WHERE x.session_id = sessions.id)`, []any{}
	if before != "" {
		q += ` AND started_at < ?`
		args = append(args, before)
	}
	rows, err := d.sql.QueryContext(ctx, q+` ORDER BY started_at DESC, rowid DESC LIMIT ?`, append(args, limit)...)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	out := []Session{}
	for _, id := range ids {
		s, err := loadSession(ctx, d.sql, id)
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, nil
}

// SessionOf returns one session and its exchanges in order (forgotten ones as markers).
func (d *DB) SessionOf(ctx context.Context, id string) (Session, []Exchange, error) {
	s, err := loadSession(ctx, d.sql, id)
	if err != nil {
		return s, nil, err
	}
	rows, err := d.sql.QueryContext(ctx, `SELECT `+exchangeCols+` FROM exchanges WHERE session_id = ? ORDER BY started_at, rowid`, id)
	if err != nil {
		return s, nil, err
	}
	defer rows.Close()
	out := []Exchange{}
	for rows.Next() {
		e, err := scanExchange(rows)
		if err != nil {
			return s, nil, err
		}
		out = append(out, e)
	}
	return s, out, rows.Err()
}

// ExchangeByID returns one exchange.
func (d *DB) ExchangeByID(ctx context.Context, id string) (Exchange, error) {
	e, err := scanExchange(d.sql.QueryRowContext(ctx, `SELECT `+exchangeCols+` FROM exchanges WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return e, ErrNotFound
	}
	return e, err
}

// ForgetExchange deletes the texts of an exchange and its search entries and
// leaves a marker row. It returns the session the marker stays in.
func (d *DB) ForgetExchange(ctx context.Context, id string) (string, error) {
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback() }()
	var sid string
	if err := tx.QueryRowContext(ctx, `SELECT session_id FROM exchanges WHERE id = ?`, id).Scan(&sid); errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	} else if err != nil {
		return "", err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE exchanges SET removed = 1, request = '', answer = '', answer_truncated = 0,
		files_json = '[]', agents_json = '[]', task_id = '' WHERE id = ?`, id); err != nil {
		return "", err
	}
	if err := delDoc(ctx, tx, DocExchange, id); err != nil {
		return "", err
	}
	return sid, tx.Commit()
}

// PreviousSession is the newest session other than id that holds an exchange.
func (d *DB) PreviousSession(ctx context.Context, id string) (Session, error) {
	var sid string
	err := d.sql.QueryRowContext(ctx, `SELECT s.id FROM sessions s WHERE s.kind = 'main' AND s.id != ? AND EXISTS
		(SELECT 1 FROM exchanges e WHERE e.session_id = s.id AND e.removed = 0) ORDER BY s.started_at DESC, s.rowid DESC LIMIT 1`, id).Scan(&sid)
	if errors.Is(err, sql.ErrNoRows) {
		return Session{}, ErrNotFound
	}
	if err != nil {
		return Session{}, err
	}
	return loadSession(ctx, d.sql, sid)
}

// SessionOfTurn returns the session that holds a turn, ErrNotFound if none.
func (d *DB) SessionOfTurn(ctx context.Context, turnID int64) (string, error) {
	var sid string
	err := d.sql.QueryRowContext(ctx, `SELECT session_id FROM exchanges WHERE turn_id = ?`, turnID).Scan(&sid)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return sid, err
}

// TurnUsage sums the tokens and cost of the usage rows recorded since a turn
// started: the agents' own requests and the router's classifier calls, not the
// side calls (digest, completion). Flat-rate rows add tokens but no cost.
func (d *DB) TurnUsage(ctx context.Context, since string) (Tokens, *float64, error) {
	var t Tokens
	var cost sql.NullFloat64
	err := d.sql.QueryRowContext(ctx, `SELECT COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0),
		SUM(CASE WHEN flat_rate = 0 THEN cost_usd END) FROM usage WHERE created_at >= ? AND (role IS NULL OR role = ?)`, since, RoleRoute).
		Scan(&t.Input, &t.Output, &cost)
	if cost.Valid {
		v := cost.Float64
		return t, &v, err
	}
	return t, nil, err
}

// SubAgentTitles lists the titles of the sub-agents created since a turn
// started (the rewound ones excluded), in creation order.
func (d *DB) SubAgentTitles(ctx context.Context, since string) ([]string, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT title FROM agents WHERE parent_id IS NOT NULL AND created_at >= ? AND rewound_at IS NULL ORDER BY rowid`, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// ChangedPaths lists the distinct paths the changes ledger recorded for a
// turn, at most 50.
func (d *DB) ChangedPaths(ctx context.Context, turnID int64) ([]string, error) {
	cs, err := d.Changes(ctx, turnID)
	if err != nil {
		return nil, err
	}
	out := []string{}
	seen := map[string]bool{}
	for _, c := range cs {
		if !seen[c.Path] && len(out) < 50 {
			seen[c.Path] = true
			out = append(out, c.Path)
		}
	}
	return out, nil
}
