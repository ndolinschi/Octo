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
	// Manual: the user asked for it (POST /compact); MessageCount how many messages it replaced (manual only).
	Manual       bool
	MessageCount int
	// Cleared marks a clear (POST /clear): no summary, a new conversation starts after UptoMessageID.
	Cleared        bool
	ConversationID string
	// SummarySource ("model", "agent" or "stored") says who wrote a clear's summary; Title names
	// the session that ended.
	SummarySource string
	Title         string
}

const compactionCols = `id, agent_id, summary, upto_message_id, created_at, COALESCE(usage_id, 0), manual, message_count, cleared, conversation_id, summary_source, title`

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
		agentID).Scan(&c.ID, &c.AgentID, &c.Summary, &c.UptoMessageID, &c.CreatedAt, &c.UsageID, &c.Manual, &c.MessageCount, &c.Cleared, &c.ConversationID, &c.SummarySource, &c.Title)
	if err == sql.ErrNoRows {
		return Compaction{}, false, nil
	}
	return c, err == nil, err
}

// Compactions lists the agent's compactions, oldest first (clears are listed by Clears).
func (d *DB) Compactions(ctx context.Context, agentID string) ([]Compaction, error) {
	return d.compactionRows(ctx, agentID, false)
}

// Clears lists the agent's conversation boundaries, oldest first.
func (d *DB) Clears(ctx context.Context, agentID string) ([]Compaction, error) {
	return d.compactionRows(ctx, agentID, true)
}

// AddClear stores a conversation boundary after the agent's last message: the
// messages stay (transcript, search, export) but no request carries them; carryOver
// (the summary, open task titles and a pointer to recall the rest) is what the
// next request starts from.
func (d *DB) AddClear(ctx context.Context, agentID, conversationID, carryOver, source, title string) (Compaction, error) {
	c, err := d.AddCompaction(ctx, agentID, carryOver)
	if err != nil {
		return c, err
	}
	_, err = d.sql.ExecContext(ctx, `UPDATE compactions SET cleared = 1, conversation_id = ?, summary_source = ?, title = ? WHERE id = ?`,
		conversationID, source, title, c.ID)
	c.Cleared, c.ConversationID, c.SummarySource, c.Title = true, conversationID, source, title
	return c, err
}

// LatestClearUpto is the id of the last message before the agent's newest
// conversation boundary (0: never cleared). Messages up to it are not part of
// the current conversation.
func (d *DB) LatestClearUpto(ctx context.Context, agentID string) (int64, error) {
	var upto int64
	err := d.sql.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(upto_message_id), 0) FROM compactions WHERE agent_id = ? AND cleared = 1`, agentID).Scan(&upto)
	return upto, err
}

func (d *DB) compactionRows(ctx context.Context, agentID string, cleared bool) ([]Compaction, error) {
	rows, err := d.sql.QueryContext(ctx,
		`SELECT `+compactionCols+` FROM compactions WHERE agent_id = ? AND cleared = ? ORDER BY id`, agentID, cleared)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Compaction{}
	for rows.Next() {
		var c Compaction
		if err := rows.Scan(&c.ID, &c.AgentID, &c.Summary, &c.UptoMessageID, &c.CreatedAt, &c.UsageID, &c.Manual, &c.MessageCount, &c.Cleared, &c.ConversationID, &c.SummarySource, &c.Title); err != nil {
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
