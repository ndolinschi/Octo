package projectstore

import (
	"context"
	"database/sql"
	"errors"
)

// QueuedMessage is a user message waiting for the running turn to end.
type QueuedMessage struct {
	ID        string `json:"id"`
	Text      string `json:"text"`
	CreatedAt string `json:"created_at"`
	// Mode is the mode chosen for this message ("": the project's).
	Mode string `json:"mode,omitempty"`
	// Attachments are the ids of the images that go with the message.
	Attachments []string `json:"attachments,omitempty"`
}

// MaxQueue is the most messages a project queues.
const MaxQueue = 20

// ErrQueueFull is returned by Enqueue at MaxQueue messages.
var ErrQueueFull = errors.New("projectstore: queue full")

// Queue returns the queued messages in order and whether the queue is paused.
func (d *DB) Queue(ctx context.Context) ([]QueuedMessage, bool, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT id, text, created_at, mode, attachments FROM queue ORDER BY seq`)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	out := []QueuedMessage{}
	for rows.Next() {
		var m QueuedMessage
		var att string
		if err := rows.Scan(&m.ID, &m.Text, &m.CreatedAt, &m.Mode, &att); err != nil {
			return nil, false, err
		}
		m.Attachments = decodeIDs(att)
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	var paused int
	if err := d.sql.QueryRowContext(ctx, `SELECT queue_paused FROM project WHERE id = 1`).Scan(&paused); err != nil {
		return nil, false, err
	}
	return out, paused != 0, nil
}

// Enqueue appends a message; ErrQueueFull at MaxQueue.
func (d *DB) Enqueue(ctx context.Context, text string) (QueuedMessage, error) {
	return d.EnqueueMode(ctx, text, "")
}

// EnqueueMode is Enqueue with a mode chosen for the message.
func (d *DB) EnqueueMode(ctx context.Context, text, mode string) (QueuedMessage, error) {
	return d.EnqueueWith(ctx, text, mode, nil)
}

// EnqueueWith is EnqueueMode with the ids of attached images.
func (d *DB) EnqueueWith(ctx context.Context, text, mode string, attachments []string) (QueuedMessage, error) {
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return QueuedMessage{}, err
	}
	defer func() { _ = tx.Rollback() }()
	var n, maxSeq int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*), COALESCE(MAX(seq), 0) FROM queue`).Scan(&n, &maxSeq); err != nil {
		return QueuedMessage{}, err
	}
	if n >= MaxQueue {
		return QueuedMessage{}, ErrQueueFull
	}
	m := QueuedMessage{ID: NewID("q"), Text: text, CreatedAt: Now(), Mode: mode, Attachments: attachments}
	if _, err := tx.ExecContext(ctx, `INSERT INTO queue (id, seq, text, created_at, mode, attachments) VALUES (?, ?, ?, ?, ?, ?)`,
		m.ID, maxSeq+1, m.Text, m.CreatedAt, m.Mode, encodeIDs(attachments)); err != nil {
		return QueuedMessage{}, err
	}
	return m, tx.Commit()
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
	var m QueuedMessage
	err = d.sql.QueryRowContext(ctx, `SELECT id, text, created_at FROM queue WHERE id = ?`, id).Scan(&m.ID, &m.Text, &m.CreatedAt)
	return m, err
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

// ClearQueue deletes every queued message.
func (d *DB) ClearQueue(ctx context.Context) error {
	_, err := d.sql.ExecContext(ctx, `DELETE FROM queue`)
	return err
}

// PopQueued removes and returns the first queued message; false when empty.
func (d *DB) PopQueued(ctx context.Context) (QueuedMessage, bool, error) {
	var m QueuedMessage
	err := d.sql.QueryRowContext(ctx, `DELETE FROM queue WHERE id = (SELECT id FROM queue ORDER BY seq LIMIT 1)
		RETURNING id, text, created_at`).Scan(&m.ID, &m.Text, &m.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return m, false, nil
	}
	return m, err == nil, err
}

// MoveQueuedFirst puts a queued message at the head of the queue.
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

// SetQueuePaused records whether the queue waits for an explicit resume.
func (d *DB) SetQueuePaused(ctx context.Context, paused bool) error {
	v := 0
	if paused {
		v = 1
	}
	_, err := d.sql.ExecContext(ctx, `UPDATE project SET queue_paused = ? WHERE id = 1`, v)
	return err
}
