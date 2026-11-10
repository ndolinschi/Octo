package projectstore

import (
	"context"
	"fmt"
)

// agentColumnsAdded lists agents columns added after the first release.
var agentColumnsAdded = []struct{ name, ddl string }{
	{"context_used", "INTEGER"},
	{"context_size", "INTEGER"},
}

// migrate brings a project database up to the current schema. It is
// idempotent: new tables use IF NOT EXISTS and columns are added only when
// missing, so it is safe on fresh, current and older databases alike.
func (d *DB) migrate(ctx context.Context) error {
	if _, err := d.sql.ExecContext(ctx, projectSchema); err != nil {
		return fmt.Errorf("project schema: %w", err)
	}
	have, err := d.columns(ctx, "agents")
	if err != nil {
		return err
	}
	for _, c := range agentColumnsAdded {
		if have[c.name] {
			continue
		}
		if _, err := d.sql.ExecContext(ctx, "ALTER TABLE agents ADD COLUMN "+c.name+" "+c.ddl); err != nil {
			return fmt.Errorf("add agents.%s: %w", c.name, err)
		}
	}
	return nil
}

func (d *DB) columns(ctx context.Context, table string) (map[string]bool, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT name FROM pragma_table_info(?)`, table)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		out[n] = true
	}
	return out, rows.Err()
}
