package projectstore

import (
	"context"
	"database/sql"
)

// ReportedContext is the input a model reported for one agent request: the
// size of the request that response answered.
type ReportedContext struct {
	Model       string
	ServedModel string
	// Tokens is input plus cache read plus cache write tokens.
	Tokens int64
}

// LastReportedContext returns the agent's newest API response report that was
// made after its latest compaction (a figure from before it no longer describes
// the history) and is not a compaction request itself. ok is false when there
// is none. Side-question rows never count.
func (d *DB) LastReportedContext(ctx context.Context, agentID string) (r ReportedContext, ok bool, err error) {
	after := int64(0)
	if c, found, err := d.LatestCompaction(ctx, agentID); err != nil {
		return r, false, err
	} else if found {
		after = c.UsageID
		if after == 0 { // stored before usage_id existed: fall back to the clock
			err = d.sql.QueryRowContext(ctx,
				`SELECT COALESCE(MAX(id), 0) FROM usage WHERE agent_id = ? AND created_at <= ?`, agentID, c.CreatedAt).Scan(&after)
			if err != nil {
				return r, false, err
			}
		}
	}
	err = d.sql.QueryRowContext(ctx, `SELECT model, COALESCE(served_model, ''), input_tokens + cache_read_tokens + cache_write_tokens
		FROM usage WHERE agent_id = ? AND source = ? AND role IS NULL AND id > ? AND input_tokens + cache_read_tokens + cache_write_tokens > 0 AND COALESCE(route_trigger, '') <> 'compact'
		ORDER BY id DESC LIMIT 1`, agentID, SourceAPI, after).Scan(&r.Model, &r.ServedModel, &r.Tokens)
	if err == sql.ErrNoRows {
		return ReportedContext{}, false, nil
	}
	return r, err == nil, err
}
