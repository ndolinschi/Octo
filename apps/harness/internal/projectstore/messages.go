package projectstore

import (
	"context"
	"encoding/json"
)

// Message is a stored turn. Content is the normalized view of Raw.
type Message struct {
	ID        int64           `json:"id"`
	AgentID   string          `json:"agent_id"`
	Role      string          `json:"role"`
	Content   []ContentBlock  `json:"content"`
	CreatedAt string          `json:"created_at"`
	Raw       json.RawMessage `json:"-"`
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
		`SELECT id, role, content_json, created_at FROM messages WHERE agent_id = ? ORDER BY id`, agentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Message{}
	for rows.Next() {
		var id int64
		var role, content, created string
		if err := rows.Scan(&id, &role, &content, &created); err != nil {
			return nil, err
		}
		out = append(out, newMessage(id, agentID, role, []byte(content), created))
	}
	return out, rows.Err()
}

func newMessage(id int64, agentID, role string, raw []byte, created string) Message {
	return Message{
		ID: id, AgentID: agentID, Role: role, CreatedAt: created,
		Raw: raw, Content: NormalizeContent(raw),
	}
}
