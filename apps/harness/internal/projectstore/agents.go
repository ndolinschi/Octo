package projectstore

import (
	"context"
	"database/sql"
)

// lastRowOf selects one column of the agent's newest main-thread API usage row
// (not a side question, not a compaction request). NULLIF turns "" into NULL,
// so a call that went straight to a provider reports no served model or tier.
func lastRowOf(col string) string {
	return `(SELECT NULLIF(` + col + `, '') FROM usage u WHERE u.agent_id = agents.id AND u.source = 'api' AND u.role IS NULL
		AND COALESCE(u.route_trigger, '') <> 'compact' ORDER BY u.id DESC LIMIT 1)`
}

var agentCols = `id, parent_id, depth, role, title, task, model, tier, status, result, error,
	spawn_tool_use_id, input_tokens, output_tokens, created_at, started_at, finished_at,
	context_used, context_size, route_reason, route_band, route_request_id, route_choice, ` + lastRowOf("u.served_model") + `, ` + lastRowOf("u.tier")

type scanner interface{ Scan(dest ...any) error }

func (d *DB) scanAgent(r scanner) (Agent, error) {
	a := Agent{ProjectID: d.id}
	var tier sql.NullString
	var parent, result, errText, spawn, started, finished sql.NullString
	var ctxUsed, ctxSize sql.NullInt64
	var served, routed, rReason, rBand, rReq, rChoice sql.NullString
	err := r.Scan(&a.ID, &parent, &a.Depth, &a.Role, &a.Title, &a.Task, &a.Model, &tier, &a.Status,
		&result, &errText, &spawn, &a.InputTokens, &a.OutputTokens, &a.CreatedAt, &started, &finished, &ctxUsed, &ctxSize,
		&rReason, &rBand, &rReq, &rChoice, &served, &routed)
	if err != nil {
		return a, err
	}
	a.ParentID = nullStr(parent)
	a.Result = nullStr(result)
	a.Error = nullStr(errText)
	a.SpawnToolUseID = nullStr(spawn)
	a.StartedAt = nullStr(started)
	a.FinishedAt = nullStr(finished)
	a.ContextUsed = nullInt(ctxUsed)
	a.ContextSize = nullInt(ctxSize)
	a.ServedModel = nullStr(served)
	a.RoutedTier = nullStr(routed)
	a.RouteReason, a.RouteBand, a.RouteRequestID, a.RouteChoice = nullStr(rReason), nullStr(rBand), nullStr(rReq), nullStr(rChoice)
	if tier.Valid {
		t := Tier(tier.String)
		a.Tier = &t
	}
	return a, nil
}

func nullStr(n sql.NullString) *string {
	if !n.Valid {
		return nil
	}
	return &n.String
}

func nullInt(n sql.NullInt64) *int64 {
	if !n.Valid {
		return nil
	}
	return &n.Int64
}

func (d *DB) CreateAgent(ctx context.Context, in NewAgent) (Agent, error) {
	id := NewID("agt")
	now := Now()
	var started any
	if in.Started {
		started = now
	}
	var tier any
	if in.Tier != nil {
		tier = string(*in.Tier)
	}
	var route RouteInfo
	if in.Route != nil {
		route = *in.Route
	}
	_, err := d.sql.ExecContext(ctx,
		`INSERT INTO agents (id, parent_id, depth, role, title, task, model, tier, status, spawn_tool_use_id, created_at, started_at,
			route_reason, route_band, route_request_id, route_choice)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, in.ParentID, in.Depth, in.Role, in.Title, in.Task, in.Model, tier, string(in.Status), in.SpawnToolUseID, now, started,
		nullable(route.Reason), nullable(route.Band), nullable(route.RequestID), nullable(route.Choice))
	if err != nil {
		return Agent{}, err
	}
	if err := d.Touch(ctx); err != nil {
		return Agent{}, err
	}
	return d.Agent(ctx, id)
}

func (d *DB) Agent(ctx context.Context, id string) (Agent, error) {
	a, err := d.scanAgent(d.sql.QueryRowContext(ctx, `SELECT `+agentCols+` FROM agents WHERE id = ?`, id))
	if err == sql.ErrNoRows {
		return a, ErrNotFound
	}
	return a, err
}

func (d *DB) Agents(ctx context.Context) ([]Agent, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT `+agentCols+` FROM agents ORDER BY rowid`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Agent{}
	for rows.Next() {
		a, err := d.scanAgent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// Orchestrator returns the project's root agent.
func (d *DB) Orchestrator(ctx context.Context) (Agent, error) {
	a, err := d.scanAgent(d.sql.QueryRowContext(ctx, `SELECT `+agentCols+` FROM agents WHERE parent_id IS NULL`))
	if err == sql.ErrNoRows {
		return a, ErrNotFound
	}
	return a, err
}

func (d *DB) UpdateAgent(ctx context.Context, id string, p AgentPatch) (Agent, error) {
	set := newSetter()
	if p.Reset {
		set.add("result", nil)
		set.add("error", nil)
		set.add("finished_at", nil)
	}
	if p.Status != nil {
		set.add("status", string(*p.Status))
	}
	set.str("model", p.Model)
	set.str("result", p.Result)
	set.str("error", p.Error)
	set.str("started_at", p.StartedAt)
	set.str("finished_at", p.FinishedAt)
	if err := set.exec(ctx, d.sql, "agents", "id = ?", id); err != nil {
		return Agent{}, err
	}
	if err := d.Touch(ctx); err != nil {
		return Agent{}, err
	}
	return d.Agent(ctx, id)
}

// RecoverInterrupted settles agents left running by a previous process.
func (d *DB) RecoverInterrupted(ctx context.Context) error {
	now := Now()
	if _, err := d.sql.ExecContext(ctx,
		`UPDATE agents SET status = 'idle' WHERE parent_id IS NULL AND status = 'running'`); err != nil {
		return err
	}
	_, err := d.sql.ExecContext(ctx,
		`UPDATE agents SET status = 'failed', error = 'interrupted', finished_at = ? WHERE status = 'running'`, now)
	return err
}
