package projectstore

import (
	"context"
	"fmt"
)

// Schema 7 adds the saved approval rules ("always allow"). Its own function so
// the number can be renumbered when migrations from parallel work are merged;
// the statements are idempotent.
const approvalRulesSchema = `
CREATE TABLE IF NOT EXISTS approval_rules (
	id TEXT PRIMARY KEY,
	tool TEXT NOT NULL,
	match TEXT NOT NULL,
	exact INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	UNIQUE (tool, match, exact)
);`

func (d *DB) migrateV7(ctx context.Context) error {
	if _, err := d.sql.ExecContext(ctx, approvalRulesSchema); err != nil {
		return fmt.Errorf("approval rules schema: %w", err)
	}
	if _, err := d.sql.ExecContext(ctx, plansSchema); err != nil {
		return fmt.Errorf("plans schema: %w", err)
	}
	return nil
}

// ApprovalRule is a saved "always allow" of a project: Tool is the tool
// (bash, write_file, edit, web_fetch, or acp:<kind>); Match a command prefix
// (shell tools; the whole command when Exact), a path glob (file tools) or a
// host glob (web_fetch).
type ApprovalRule struct {
	ID        string `json:"id"`
	Tool      string `json:"tool"`
	Match     string `json:"match"`
	Exact     bool   `json:"exact"`
	CreatedAt string `json:"created_at"`
}

// AddApprovalRule saves a rule; an identical one that exists is returned as is.
func (d *DB) AddApprovalRule(ctx context.Context, tool, match string, exact bool) (ApprovalRule, error) {
	r := ApprovalRule{ID: NewID("rul"), Tool: tool, Match: match, Exact: exact, CreatedAt: Now()}
	if _, err := d.sql.ExecContext(ctx,
		`INSERT OR IGNORE INTO approval_rules (id, tool, match, exact, created_at) VALUES (?, ?, ?, ?, ?)`,
		r.ID, r.Tool, r.Match, r.Exact, r.CreatedAt); err != nil {
		return ApprovalRule{}, err
	}
	err := d.sql.QueryRowContext(ctx,
		`SELECT id, tool, match, exact, created_at FROM approval_rules WHERE tool = ? AND match = ? AND exact = ?`,
		tool, match, exact).Scan(&r.ID, &r.Tool, &r.Match, &r.Exact, &r.CreatedAt)
	return r, err
}

// ApprovalRules lists the saved rules, oldest first.
func (d *DB) ApprovalRules(ctx context.Context) ([]ApprovalRule, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT id, tool, match, exact, created_at FROM approval_rules ORDER BY created_at, rowid`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ApprovalRule{}
	for rows.Next() {
		var r ApprovalRule
		if err := rows.Scan(&r.ID, &r.Tool, &r.Match, &r.Exact, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// DeleteApprovalRule removes a rule; ErrNotFound when there is none.
func (d *DB) DeleteApprovalRule(ctx context.Context, id string) error {
	res, err := d.sql.ExecContext(ctx, `DELETE FROM approval_rules WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
