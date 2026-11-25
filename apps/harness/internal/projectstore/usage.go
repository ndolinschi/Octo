package projectstore

import (
	"context"
	"database/sql"
	"errors"
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

// RoleSide is the usage role of side-question requests.
const RoleSide = "side"

// RoleRoute is the usage role of the router's classifier call that chose who
// does a delegated task (tier "auto"); the row belongs to the spawning agent.
const RoleRoute = "route"

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
	// ServedModel, Tier, RouteTrigger and RouterRequestID come from an Octo
	// router's result headers and call record; empty when there is none.
	ServedModel     string
	Tier            string
	RouteTrigger    string
	RouterRequestID string
	// CostEstimated marks CostUSD as the router's own estimate, not a reported price.
	CostEstimated bool
	// Role marks a row that belongs to no agent's own thread ("side": a side
	// question; "route": the router's classifier call for a delegation); empty for an agent's own requests. Such a row is attributed to
	// AgentID but not added to the agent's token totals.
	Role string
	// FlatRate marks a row of a flat-rate (subscription) agent: CostUSD is its
	// own estimate of what the usage would cost per token, not money spent. It
	// never counts toward spend, budgets or cost totals.
	FlatRate bool
	// TokensEstimated marks the token counts as the harness's own estimate (from
	// streamed text), because the agent reported none.
	TokensEstimated bool
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
	if r.Role == "" {
		res, err := tx.ExecContext(ctx, `UPDATE agents SET `+set+` WHERE id = ?`, append(args, r.AgentID)...)
		if err != nil {
			return Agent{}, err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return Agent{}, ErrNotFound
		}
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
		`INSERT INTO usage (agent_id, model, source, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, created_at,
			served_model, tier, route_trigger, router_request_id, cost_estimated, role, flat_rate, tokens_estimated)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.AgentID, r.Model, r.Source, r.InputTokens, r.OutputTokens, r.CacheReadTokens, r.CacheWriteTokens, cost, at,
		nullable(r.ServedModel), nullable(r.Tier), nullable(r.RouteTrigger), nullable(r.RouterRequestID), r.CostEstimated,
		nullable(r.Role), r.FlatRate, r.TokensEstimated)
	if err != nil {
		return Agent{}, err
	}
	if err := tx.Commit(); err != nil {
		return Agent{}, err
	}
	return d.Agent(ctx, r.AgentID)
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
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
	// Flat marks rows of flat-rate agents; their ReportedCostUSD is a
	// subscription equivalent, not spend.
	Flat bool
	// TokensEstimated: some token counts here are the harness's estimate.
	TokensEstimated bool
	// ReportedEstimated is set when the reported cost is a router estimate.
	ReportedEstimated bool
	InputTokens       int64
	OutputTokens      int64
	CacheReadTokens   int64
	CacheWriteTokens  int64
	Requests          int64
	// ReportedCostUSD is the summed source-reported cost (zero unless Reported).
	ReportedCostUSD float64
}

// servedModel is the model that answered: the router's when it named one,
// else the one the harness asked for.
const servedModel = "COALESCE(NULLIF(u.served_model, ''), u.model)"

// keyExprs maps a group to the SQL key and label expressions. The project
// group has a single bucket per database; its key is filled in by UsageRows.
var keyExprs = map[UsageGroup][2]string{
	GroupDay:     {"substr(u.created_at, 1, 10)", "substr(u.created_at, 1, 10)"},
	GroupModel:   {servedModel, servedModel},
	GroupAgent:   {"COALESCE(u.role, u.agent_id)", "COALESCE(u.role, a.role, u.agent_id)"},
	GroupProject: {"''", "''"},
}

// UsageRows sums the rows with from <= created_at < to (fixed-width RFC 3339
// UTC strings, as Now returns) by group.
func (d *DB) UsageRows(ctx context.Context, from, to string, g UsageGroup) ([]UsageRow, error) {
	exprs, ok := keyExprs[g]
	if !ok {
		return nil, fmt.Errorf("projectstore: unknown usage group %q", g)
	}
	rows, err := d.sql.QueryContext(ctx, `SELECT `+exprs[0]+`, `+exprs[1]+`, `+servedModel+`, u.source, u.cost_usd IS NOT NULL, u.cost_estimated, u.flat_rate,
		SUM(u.input_tokens), SUM(u.output_tokens), SUM(u.cache_read_tokens), SUM(u.cache_write_tokens),
		COUNT(*), COALESCE(SUM(u.cost_usd), 0), MAX(u.tokens_estimated)
		FROM usage u LEFT JOIN agents a ON a.id = u.agent_id
		WHERE u.created_at >= ? AND u.created_at < ?
		GROUP BY 1, 2, 3, 4, 5, 6, 7`, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []UsageRow
	for rows.Next() {
		var r UsageRow
		if err := rows.Scan(&r.Key, &r.Label, &r.Model, &r.Source, &r.Reported, &r.ReportedEstimated, &r.Flat, &r.InputTokens, &r.OutputTokens,
			&r.CacheReadTokens, &r.CacheWriteTokens, &r.Requests, &r.ReportedCostUSD, &r.TokensEstimated); err != nil {
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

// UsageEntry is one stored usage row, oldest first in UsageLog.
type UsageEntry struct {
	AgentID         string
	Model           string
	ServedModel     string
	Tier            string
	RouteTrigger    string
	RouterRequestID string
	Source          string
	InputTokens     int64
	OutputTokens    int64
	CostUSD         *float64
	CostEstimated   bool
	FlatRate        bool
	TokensEstimated bool
	// Role is "side" or "route" for rows outside an agent's own thread, empty for an agent's own requests.
	Role      string
	CreatedAt string
}

// UsageLog returns every usage row in insertion order.
func (d *DB) UsageLog(ctx context.Context) ([]UsageEntry, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT agent_id, model, COALESCE(served_model, ''), COALESCE(tier, ''),
		COALESCE(route_trigger, ''), COALESCE(router_request_id, ''), source, input_tokens, output_tokens, cost_usd,
		cost_estimated, flat_rate, tokens_estimated, COALESCE(role, ''), created_at FROM usage ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []UsageEntry
	for rows.Next() {
		var e UsageEntry
		var cost sql.NullFloat64
		if err := rows.Scan(&e.AgentID, &e.Model, &e.ServedModel, &e.Tier, &e.RouteTrigger, &e.RouterRequestID,
			&e.Source, &e.InputTokens, &e.OutputTokens, &cost, &e.CostEstimated, &e.FlatRate, &e.TokensEstimated, &e.Role, &e.CreatedAt); err != nil {
			return nil, err
		}
		if cost.Valid {
			e.CostUSD = &cost.Float64
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// UsageTotals is the sum of an agent's own usage rows (role empty): what its
// thread used, for a delegation's outcome report.
type UsageTotals struct {
	InputTokens, OutputTokens, CacheReadTokens, CacheWriteTokens int64
	// CostUSD sums the rows that carry a cost; nil when none does.
	CostUSD *float64
	// CostEstimated: some summed cost is an estimate (the router's table, or
	// tokens the harness estimated). FlatRate: some row is a subscription
	// agent's per-token estimate, not money.
	CostEstimated, FlatRate bool
}

// AgentUsageTotals sums the agent's own usage rows.
func (d *DB) AgentUsageTotals(ctx context.Context, agentID string) (UsageTotals, error) {
	var t UsageTotals
	var cost sql.NullFloat64
	var est, flat, tokEst int64
	err := d.sql.QueryRowContext(ctx, `SELECT COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
		COALESCE(SUM(cache_read_tokens), 0), COALESCE(SUM(cache_write_tokens), 0), SUM(cost_usd),
		COALESCE(MAX(cost_estimated), 0), COALESCE(MAX(flat_rate), 0), COALESCE(MAX(tokens_estimated), 0)
		FROM usage WHERE agent_id = ? AND role IS NULL`, agentID).
		Scan(&t.InputTokens, &t.OutputTokens, &t.CacheReadTokens, &t.CacheWriteTokens, &cost, &est, &flat, &tokEst)
	if err != nil {
		return UsageTotals{}, err
	}
	if cost.Valid {
		v := cost.Float64
		t.CostUSD = &v
	}
	t.CostEstimated, t.FlatRate = est != 0 || tokEst != 0, flat != 0
	return t, nil
}

// ACPUsageSince sums the cost and input tokens of the agent's ACP usage rows
// recorded at or after since: what an ACP session has reported so far, so a
// process that resumes it can continue the session's cumulative counters.
func (d *DB) ACPUsageSince(ctx context.Context, agentID, since string) (costUSD float64, tokens int64, err error) {
	err = d.sql.QueryRowContext(ctx, `SELECT COALESCE(SUM(cost_usd), 0), COALESCE(SUM(input_tokens), 0)
		FROM usage WHERE agent_id = ? AND source = ? AND role IS NULL AND created_at >= ?`, agentID, SourceACP, since).Scan(&costUSD, &tokens)
	return costUSD, tokens, err
}

// AddOutputTokens adds output tokens to the agent's newest usage row of source
// that is not older than since (a stamp, as Stamp makes it), and to the agent's
// totals: what an ACP agent wrote in a turn goes on the turn's last usage row,
// not on a row of its own. estimated marks the row's token counts as the
// harness's estimate. found is false when there is no such row (the caller
// records one).
func (d *DB) AddOutputTokens(ctx context.Context, agentID, source, since string, out int64, estimated bool) (found bool, err error) {
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()
	var id int64
	err = tx.QueryRowContext(ctx, `SELECT id FROM usage WHERE agent_id = ? AND source = ? AND role IS NULL AND created_at >= ? ORDER BY id DESC LIMIT 1`,
		agentID, source, since).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE usage SET output_tokens = output_tokens + ?, tokens_estimated = MAX(tokens_estimated, ?) WHERE id = ?`, out, estimated, id); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE agents SET output_tokens = output_tokens + ? WHERE id = ?`, out, agentID); err != nil {
		return false, err
	}
	return true, tx.Commit()
}

// ResetContext forgets an agent's own report of its context occupancy (a clear).
func (d *DB) ResetContext(ctx context.Context, id string) error {
	_, err := d.sql.ExecContext(ctx, `UPDATE agents SET context_used = NULL, context_size = NULL WHERE id = ?`, id)
	return err
}
