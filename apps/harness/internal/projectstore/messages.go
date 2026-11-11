package projectstore

import (
	"context"
	"encoding/json"
)

// Message is a stored turn. Content is the normalized view of Raw.
type Message struct {
	ID        int64          `json:"id"`
	AgentID   string         `json:"agent_id"`
	Role      string         `json:"role"`
	Content   []ContentBlock `json:"content"`
	CreatedAt string         `json:"created_at"`
	// Stopped marks an assistant message cut short because the turn was cancelled.
	Stopped bool            `json:"stopped,omitempty"`
	Raw     json.RawMessage `json:"-"`
}

func (d *DB) AppendMessage(ctx context.Context, agentID, role string, contentJSON []byte) (Message, error) {
	now := Now()
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return Message{}, err
	}
	defer func() { _ = tx.Rollback() }()
	res, err := tx.ExecContext(ctx,
		`INSERT INTO messages (agent_id, role, content_json, created_at) VALUES (?, ?, ?, ?)`,
		agentID, role, string(contentJSON), now)
	if err != nil {
		return Message{}, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return Message{}, err
	}
	// The user and assistant texts are searchable; tool output is not. The
	// index is written in the same transaction as the message.
	if role == "user" || role == "assistant" {
		if text := messageText(contentJSON); text != "" {
			if err := putDoc(ctx, tx, messageDoc(id, role, d.scrub(text), now)); err != nil {
				return Message{}, err
			}
		}
	}
	if err := tx.Commit(); err != nil {
		return Message{}, err
	}
	if err := d.Touch(ctx); err != nil {
		return Message{}, err
	}
	return newMessage(id, agentID, role, contentJSON, now), nil
}

func (d *DB) Messages(ctx context.Context, agentID string) ([]Message, error) {
	rows, err := d.sql.QueryContext(ctx,
		`SELECT id, role, content_json, created_at, stopped FROM messages WHERE agent_id = ? ORDER BY id`, agentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Message{}
	for rows.Next() {
		var id int64
		var role, content, created string
		var stopped bool
		if err := rows.Scan(&id, &role, &content, &created, &stopped); err != nil {
			return nil, err
		}
		m := newMessage(id, agentID, role, []byte(content), created)
		m.Stopped = stopped
		out = append(out, m)
	}
	return out, rows.Err()
}

func newMessage(id int64, agentID, role string, raw []byte, created string) Message {
	return Message{
		ID: id, AgentID: agentID, Role: role, CreatedAt: created,
		Raw: raw, Content: NormalizeContent(raw),
	}
}

// MarkStopped flags an assistant message as cut short by a cancelled turn.
func (d *DB) MarkStopped(ctx context.Context, id int64) error {
	_, err := d.sql.ExecContext(ctx, `UPDATE messages SET stopped = 1 WHERE id = ?`, id)
	return err
}

// UpdateMessageContent replaces a stored message's content (a tool call whose
// input arrived after the call was announced). Only for messages that are not
// indexed (tool rows).
func (d *DB) UpdateMessageContent(ctx context.Context, id int64, contentJSON []byte) (Message, error) {
	res, err := d.sql.ExecContext(ctx, `UPDATE messages SET content_json = ? WHERE id = ?`, string(contentJSON), id)
	if err != nil {
		return Message{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return Message{}, ErrNotFound
	}
	var agentID, role, created string
	var stopped bool
	if err := d.sql.QueryRowContext(ctx, `SELECT agent_id, role, created_at, stopped FROM messages WHERE id = ?`, id).Scan(&agentID, &role, &created, &stopped); err != nil {
		return Message{}, err
	}
	m := newMessage(id, agentID, role, contentJSON, created)
	m.Stopped = stopped
	return m, nil
}
