package projectstore

import (
	"context"
	"database/sql"
	"errors"
)

// QueuedMessage is a user message waiting for its session's running turn to end, or for a free slot (schema 15:
// every main session has its own queue).
type QueuedMessage struct {
	ID        string `json:"id"`
	Text      string `json:"text"`
	CreatedAt string `json:"created_at"`
	// Mode is the mode chosen for this message ("": the project's).
	Mode string `json:"mode,omitempty"`
	// Attachments are the ids of the images that go with the message.
	Attachments []string `json:"attachments,omitempty"`
	// SessionID is the main session the message waits in; WaitingFor says what for: "turn" (the session's own
	// turn runs) or "slot" (the running caps are reached).
	SessionID  string `json:"session_id"`
	WaitingFor string `json:"waiting_for,omitempty"`
}

// Waiting reasons of a queued message.
const (
	WaitingTurn = "turn"
	WaitingSlot = "slot"
)

// MaxQueue is the most messages a session queues.
const MaxQueue = 20

// ErrQueueFull is returned by Enqueue at MaxQueue messages.
var ErrQueueFull = errors.New("projectstore: queue full")

// orDefault resolves "" to the default session.
func (d *DB) orDefault(ctx context.Context, sid string) (string, error) {
	if sid != "" {
		return sid, nil
	}
	return ensureCurrentMain(ctx, d.sql)
}

const queueCols = `id, text, created_at, mode, attachments, session_id, waiting_for`

func scanQueued(sc interface{ Scan(...any) error }) (QueuedMessage, error) {
	var m QueuedMessage
	var att string
	err := sc.Scan(&m.ID, &m.Text, &m.CreatedAt, &m.Mode, &att, &m.SessionID, &m.WaitingFor)
	m.Attachments = decodeIDs(att)
	return m, err
}

// Queue returns the default session's queued messages in order and whether its queue is paused.
func (d *DB) Queue(ctx context.Context) ([]QueuedMessage, bool, error) {
	return d.SessionQueue(ctx, "")
}

// SessionQueue returns a session's queued messages in order and whether its queue is paused ("": the default).
func (d *DB) SessionQueue(ctx context.Context, sid string) ([]QueuedMessage, bool, error) {
	sid, err := d.orDefault(ctx, sid)
	if err != nil {
		return nil, false, err
	}
	rows, err := d.sql.QueryContext(ctx, `SELECT `+queueCols+` FROM queue WHERE session_id = ? ORDER BY seq`, sid)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	out := []QueuedMessage{}
	for rows.Next() {
		m, err := scanQueued(rows)
		if err != nil {
			return nil, false, err
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	var paused int
	err = d.sql.QueryRowContext(ctx, `SELECT queue_paused FROM sessions WHERE id = ?`, sid).Scan(&paused)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, false, err
	}
	return out, paused != 0, nil
}

// QueuedSessions lists the sessions that hold queued messages, with the first one of each (by seq).
func (d *DB) QueuedSessions(ctx context.Context) ([]QueuedMessage, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT `+queueCols+` FROM queue q WHERE q.seq = (SELECT MIN(seq) FROM queue r WHERE r.session_id = q.session_id) ORDER BY q.seq`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []QueuedMessage{}
	for rows.Next() {
		m, err := scanQueued(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// QueuedMessageByID returns one queued message; ErrNotFound when there is none.
func (d *DB) QueuedMessageByID(ctx context.Context, id string) (QueuedMessage, error) {
	m, err := scanQueued(d.sql.QueryRowContext(ctx, `SELECT `+queueCols+` FROM queue WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return m, ErrNotFound
	}
	return m, err
}

// Enqueue appends a message to the default session's queue; ErrQueueFull at MaxQueue.
func (d *DB) Enqueue(ctx context.Context, text string) (QueuedMessage, error) {
	return d.EnqueueMode(ctx, text, "")
}

// EnqueueMode is Enqueue with a mode chosen for the message.
func (d *DB) EnqueueMode(ctx context.Context, text, mode string) (QueuedMessage, error) {
	return d.EnqueueWith(ctx, text, mode, nil)
}

// EnqueueWith is EnqueueMode with the ids of attached images.
func (d *DB) EnqueueWith(ctx context.Context, text, mode string, attachments []string) (QueuedMessage, error) {
	return d.EnqueueIn(ctx, "", text, mode, attachments, WaitingTurn)
}

// EnqueueIn appends a message to a session's queue ("": the default); ErrQueueFull at MaxQueue messages of that
// session. seq is project-wide, so the order of messages across sessions is the order they were queued.
func (d *DB) EnqueueIn(ctx context.Context, sid, text, mode string, attachments []string, waitingFor string) (QueuedMessage, error) {
	sid, err := d.orDefault(ctx, sid)
	if err != nil {
		return QueuedMessage{}, err
	}
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return QueuedMessage{}, err
	}
	defer func() { _ = tx.Rollback() }()
	var n, maxSeq int
	if err := tx.QueryRowContext(ctx, `SELECT (SELECT COUNT(*) FROM queue WHERE session_id = ?), COALESCE((SELECT MAX(seq) FROM queue), 0)`, sid).Scan(&n, &maxSeq); err != nil {
		return QueuedMessage{}, err
	}
	if n >= MaxQueue {
		return QueuedMessage{}, ErrQueueFull
	}
	m := QueuedMessage{ID: NewID("q"), Text: text, CreatedAt: Now(), Mode: mode, Attachments: attachments, SessionID: sid, WaitingFor: waitingFor}
	if _, err := tx.ExecContext(ctx, `INSERT INTO queue (id, seq, text, created_at, mode, attachments, session_id, waiting_for) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		m.ID, maxSeq+1, m.Text, m.CreatedAt, m.Mode, encodeIDs(attachments), sid, waitingFor); err != nil {
		return QueuedMessage{}, err
	}
	return m, tx.Commit()
}

// SetWaitingFor records what a session's queued messages wait for ("turn" or "slot").
func (d *DB) SetWaitingFor(ctx context.Context, sid, waitingFor string) error {
	_, err := d.sql.ExecContext(ctx, `UPDATE queue SET waiting_for = ? WHERE session_id = ?`, waitingFor, sid)
	return err
}

// EditQueued replaces a queued message's text.
func (d *DB) EditQueued(ctx context.Context, id, text string) (QueuedMessage, error) {
	res, err := d.sql.ExecContext(ctx, `UPDATE queue SET text = ? WHERE id = ?`, text, id)
	if err != nil {
		return QueuedMessage{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return QueuedMessage{}, ErrNotFound
	}
	return d.QueuedMessageByID(ctx, id)
}

// RemoveQueued deletes a queued message.
func (d *DB) RemoveQueued(ctx context.Context, id string) error {
	res, err := d.sql.ExecContext(ctx, `DELETE FROM queue WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ClearQueue deletes every message queued in the default session.
func (d *DB) ClearQueue(ctx context.Context) error {
	return d.ClearSessionQueue(ctx, "")
}

// ClearSessionQueue deletes every message queued in a session ("": the default).
func (d *DB) ClearSessionQueue(ctx context.Context, sid string) error {
	sid, err := d.orDefault(ctx, sid)
	if err != nil {
		return err
	}
	_, err = d.sql.ExecContext(ctx, `DELETE FROM queue WHERE session_id = ?`, sid)
	return err
}

// PopQueued removes and returns the first message queued in the default session; false when empty.
func (d *DB) PopQueued(ctx context.Context) (QueuedMessage, bool, error) {
	sid, err := d.orDefault(ctx, "")
	if err != nil {
		return QueuedMessage{}, false, err
	}
	m, err := scanQueued(d.sql.QueryRowContext(ctx, `DELETE FROM queue WHERE id = (SELECT id FROM queue WHERE session_id = ? ORDER BY seq LIMIT 1)
		RETURNING `+queueCols, sid))
	if errors.Is(err, sql.ErrNoRows) {
		return m, false, nil
	}
	return m, err == nil, err
}

// MoveQueuedFirst puts a queued message at the head of its session's queue.
func (d *DB) MoveQueuedFirst(ctx context.Context, id string) error {
	res, err := d.sql.ExecContext(ctx, `UPDATE queue SET seq = (SELECT COALESCE(MIN(seq), 1) - 1 FROM queue) WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// SetQueuePaused records whether the default session's queue waits for an explicit resume.
func (d *DB) SetQueuePaused(ctx context.Context, paused bool) error {
	return d.SetSessionQueuePaused(ctx, "", paused)
}

// SetSessionQueuePaused records whether a session's queue waits for an explicit resume ("": the default).
func (d *DB) SetSessionQueuePaused(ctx context.Context, sid string, paused bool) error {
	sid, err := d.orDefault(ctx, sid)
	if err != nil {
		return err
	}
	v := 0
	if paused {
		v = 1
	}
	_, err = d.sql.ExecContext(ctx, `UPDATE sessions SET queue_paused = ? WHERE id = ?`, v, sid)
	return err
}
