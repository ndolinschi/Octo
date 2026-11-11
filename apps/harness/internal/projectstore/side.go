package projectstore

import (
	"context"
)

// SideMessage is one turn of the project's side conversation. SideID names the
// question/answer exchange the row belongs to (the question and its answer
// share it). Side messages are never part of an agent's history.
type SideMessage struct {
	ID        int64  `json:"id"`
	SideID    string `json:"side_id"`
	Role      string `json:"role"`
	Text      string `json:"text"`
	CreatedAt string `json:"created_at"`
}

func (d *DB) AppendSide(ctx context.Context, sideID, role, text string) (SideMessage, error) {
	m := SideMessage{SideID: sideID, Role: role, Text: text, CreatedAt: Now()}
	res, err := d.sql.ExecContext(ctx,
		`INSERT INTO side_messages (side_id, role, content, created_at) VALUES (?, ?, ?, ?)`,
		m.SideID, m.Role, m.Text, m.CreatedAt)
	if err != nil {
		return SideMessage{}, err
	}
	m.ID, err = res.LastInsertId()
	return m, err
}

// SideMessages returns the side conversation, oldest first.
func (d *DB) SideMessages(ctx context.Context) ([]SideMessage, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT id, side_id, role, content, created_at FROM side_messages ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SideMessage{}
	for rows.Next() {
		var m SideMessage
		if err := rows.Scan(&m.ID, &m.SideID, &m.Role, &m.Text, &m.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// DeleteSide removes one exchange's rows.
func (d *DB) DeleteSide(ctx context.Context, sideID string) error {
	_, err := d.sql.ExecContext(ctx, `DELETE FROM side_messages WHERE side_id = ?`, sideID)
	return err
}

// ClearSide removes the whole side conversation.
func (d *DB) ClearSide(ctx context.Context) error {
	_, err := d.sql.ExecContext(ctx, `DELETE FROM side_messages`)
	return err
}
