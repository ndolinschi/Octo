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
	// UsageID is the newest usage row the agent had when the summary was stored
	// (0: unknown, a database from before the column existed).
	UsageID int64
}

const compactionCols = `id, agent_id, summary, upto_message_id, created_at, COALESCE(usage_id, 0)`

// AddCompaction stores summary as covering every message the agent has so far.
func (d *DB) AddCompaction(ctx context.Context, agentID, summary string) (Compaction, error) {
	c := Compaction{AgentID: agentID, Summary: summary, CreatedAt: Now()}
	if err := d.sql.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(id), 0) FROM messages WHERE agent_id = ?`, agentID).Scan(&c.UptoMessageID); err != nil {
		return Compaction{}, err
	}
	if err := d.sql.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(id), 0) FROM usage WHERE agent_id = ? AND role IS NULL`, agentID).Scan(&c.UsageID); err != nil {
		return Compaction{}, err
	}
	res, err := d.sql.ExecContext(ctx,
		`INSERT INTO compactions (agent_id, summary, upto_message_id, created_at, usage_id) VALUES (?, ?, ?, ?, ?)`,
		agentID, summary, c.UptoMessageID, c.CreatedAt, c.UsageID)
	if err != nil {
		return Compaction{}, err
	}
	c.ID, err = res.LastInsertId()
	return c, err
}

// LatestCompaction returns the agent's newest compaction, or ok=false.
func (d *DB) LatestCompaction(ctx context.Context, agentID string) (c Compaction, ok bool, err error) {
	err = d.sql.QueryRowContext(ctx,
		`SELECT `+compactionCols+` FROM compactions WHERE agent_id = ? ORDER BY id DESC LIMIT 1`,
		agentID).Scan(&c.ID, &c.AgentID, &c.Summary, &c.UptoMessageID, &c.CreatedAt, &c.UsageID)
	if err == sql.ErrNoRows {
		return Compaction{}, false, nil
	}
	return c, err == nil, err
}

// Compactions lists the agent's compactions, oldest first.
func (d *DB) Compactions(ctx context.Context, agentID string) ([]Compaction, error) {
	rows, err := d.sql.QueryContext(ctx,
		`SELECT `+compactionCols+` FROM compactions WHERE agent_id = ? ORDER BY id`, agentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Compaction{}
	for rows.Next() {
		var c Compaction
		if err := rows.Scan(&c.ID, &c.AgentID, &c.Summary, &c.UptoMessageID, &c.CreatedAt, &c.UsageID); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// SummaryTokens estimates the size of the compaction's summary in tokens
// (characters / 4, the harness's one token estimate).
func (c Compaction) SummaryTokens() int64 { return EstimateTokens(len(c.Summary)) }

// EstimateTokens turns a character count into a token estimate (chars / 4,
// rounded up).
func EstimateTokens(chars int) int64 { return int64((chars + 3) / 4) }
