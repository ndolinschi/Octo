package projectstore

import (
	"context"
	"fmt"
)

// Usage sources.
const (
	SourceAPI = "api"
	SourceACP = "acp"
)

// UsageGroup is a way to bucket usage rows.
type UsageGroup string

const (
	GroupDay     UsageGroup = "day"
	GroupModel   UsageGroup = "model"
	GroupProject UsageGroup = "project"
	GroupAgent   UsageGroup = "agent"
)

func (g UsageGroup) Valid() bool {
	return g == GroupDay || g == GroupModel || g == GroupProject || g == GroupAgent
}

// ContextWindow is how much of an agent's context is occupied.
type ContextWindow struct{ Used, Size int64 }

// UsageRecord is one model response (api) or one ACP usage delta (acp).
type UsageRecord struct {
	AgentID          string
	Model            string
	Source           string
	InputTokens      int64
	OutputTokens     int64
	CacheReadTokens  int64
	CacheWriteTokens int64
	// CostUSD is a cost reported by the source; nil when there is none.
	CostUSD *float64
	// Context, when set, is stored on the agent in the same transaction.
	Context *ContextWindow
	// CreatedAt overrides the row time (RFC 3339 UTC, as Now returns); empty means now.
	CreatedAt string
}

// RecordUsage writes a usage row and adds the input/output tokens to the
// agent's totals atomically.
func (d *DB) RecordUsage(ctx context.Context, r UsageRecord) (Agent, error) {
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return Agent{}, err
	}
	defer func() { _ = tx.Rollback() }()
	set, args := "input_tokens = input_tokens + ?, output_tokens = output_tokens + ?", []any{r.InputTokens, r.OutputTokens}
	if r.Context != nil {
		set += ", context_used = ?, context_size = ?"
		args = append(args, r.Context.Used, r.Context.Size)
	}
	res, err := tx.ExecContext(ctx, `UPDATE agents SET `+set+` WHERE id = ?`, append(args, r.AgentID)...)
	if err != nil {
		return Agent{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return Agent{}, ErrNotFound
	}
	at := r.CreatedAt
	if at == "" {
		at = Now()
	}
	var cost any
	if r.CostUSD != nil {
		cost = *r.CostUSD
	}
	_, err = tx.ExecContext(ctx,
		`INSERT INTO usage (agent_id, model, source, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.AgentID, r.Model, r.Source, r.InputTokens, r.OutputTokens, r.CacheReadTokens, r.CacheWriteTokens, cost, at)
	if err != nil {
		return Agent{}, err
	}
	if err := tx.Commit(); err != nil {
		return Agent{}, err
	}
	return d.Agent(ctx, r.AgentID)
}

// SetContext stores an agent's context occupancy.
func (d *DB) SetContext(ctx context.Context, id string, w ContextWindow) (Agent, error) {
	res, err := d.sql.ExecContext(ctx, `UPDATE agents SET context_used = ?, context_size = ? WHERE id = ?`, w.Used, w.Size, id)
	if err != nil {
		return Agent{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return Agent{}, ErrNotFound
	}
	return d.Agent(ctx, id)
}

// UsageRow is a sum of usage rows sharing a bucket key, model, source and
// whether the source reported a cost.
type UsageRow struct {
	Key, Label, Model, Source string
	Reported                  bool
	InputTokens               int64
	OutputTokens              int64
	CacheReadTokens           int64
	CacheWriteTokens          int64
	Requests                  int64
	// ReportedCostUSD is the summed source-reported cost (zero unless Reported).
	ReportedCostUSD float64
}

// keyExprs maps a group to the SQL key and label expressions. The project
// group has a single bucket per database; its key is filled in by UsageRows.
var keyExprs = map[UsageGroup][2]string{
	GroupDay:     {"substr(u.created_at, 1, 10)", "substr(u.created_at, 1, 10)"},
	GroupModel:   {"u.model", "u.model"},
	GroupAgent:   {"u.agent_id", "COALESCE(a.role, u.agent_id)"},
	GroupProject: {"''", "''"},
}

// UsageRows sums the rows with from <= created_at < to (fixed-width RFC 3339
// UTC strings, as Now returns) by group.
func (d *DB) UsageRows(ctx context.Context, from, to string, g UsageGroup) ([]UsageRow, error) {
	exprs, ok := keyExprs[g]
	if !ok {
		return nil, fmt.Errorf("projectstore: unknown usage group %q", g)
	}
	rows, err := d.sql.QueryContext(ctx, `SELECT `+exprs[0]+`, `+exprs[1]+`, u.model, u.source, u.cost_usd IS NOT NULL,
		SUM(u.input_tokens), SUM(u.output_tokens), SUM(u.cache_read_tokens), SUM(u.cache_write_tokens),
		COUNT(*), COALESCE(SUM(u.cost_usd), 0)
		FROM usage u LEFT JOIN agents a ON a.id = u.agent_id
		WHERE u.created_at >= ? AND u.created_at < ?
		GROUP BY 1, 2, 3, 4, 5`, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []UsageRow
	for rows.Next() {
		var r UsageRow
		if err := rows.Scan(&r.Key, &r.Label, &r.Model, &r.Source, &r.Reported, &r.InputTokens, &r.OutputTokens,
			&r.CacheReadTokens, &r.CacheWriteTokens, &r.Requests, &r.ReportedCostUSD); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if g == GroupProject && len(out) > 0 {
		info, err := d.Info(ctx)
		if err != nil {
			return nil, err
		}
		for i := range out {
			out[i].Key, out[i].Label = d.id, info.Name
		}
	}
	return out, nil
}
