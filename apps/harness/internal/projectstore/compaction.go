package projectstore

import (
	"context"
	"database/sql"
)

// Compaction is a summary that stands in for an agent's messages up to and
// including UptoMessageID when the history is sent to the model. The raw
// messages stay in the messages table.
type Compaction struct {
	ID            int64
	AgentID       string
	Summary       string
	UptoMessageID int64
	CreatedAt     string
}

// AddCompaction stores summary as covering every message the agent has so far.
func (d *DB) AddCompaction(ctx context.Context, agentID, summary string) (Compaction, error) {
	c := Compaction{AgentID: agentID, Summary: summary, CreatedAt: Now()}
	if err := d.sql.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(id), 0) FROM messages WHERE agent_id = ?`, agentID).Scan(&c.UptoMessageID); err != nil {
		return Compaction{}, err
	}
	res, err := d.sql.ExecContext(ctx,
		`INSERT INTO compactions (agent_id, summary, upto_message_id, created_at) VALUES (?, ?, ?, ?)`,
		agentID, summary, c.UptoMessageID, c.CreatedAt)
	if err != nil {
		return Compaction{}, err
	}
	c.ID, err = res.LastInsertId()
	return c, err
}

// LatestCompaction returns the agent's newest compaction, or ok=false.
func (d *DB) LatestCompaction(ctx context.Context, agentID string) (c Compaction, ok bool, err error) {
	err = d.sql.QueryRowContext(ctx,
		`SELECT id, agent_id, summary, upto_message_id, created_at FROM compactions WHERE agent_id = ? ORDER BY id DESC LIMIT 1`,
		agentID).Scan(&c.ID, &c.AgentID, &c.Summary, &c.UptoMessageID, &c.CreatedAt)
	if err == sql.ErrNoRows {
		return Compaction{}, false, nil
	}
	return c, err == nil, err
}
