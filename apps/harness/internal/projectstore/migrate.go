package projectstore

import (
	"context"
	"fmt"
)

type column struct{ name, ddl string }

// columnsAdded lists, per table, the columns added after the first release.
var columnsAdded = []struct {
	table   string
	columns []column
}{
	{"agents", []column{{"context_used", "INTEGER"}, {"context_size", "INTEGER"}}},
	{"project", []column{{"budget_usd", "REAL"}}},
	{"usage", []column{
		{"served_model", "TEXT"}, {"tier", "TEXT"}, {"route_trigger", "TEXT"}, {"router_request_id", "TEXT"},
		{"cost_estimated", "INTEGER NOT NULL DEFAULT 0"}, {"role", "TEXT"},
	}},
	{"compactions", []column{{"usage_id", "INTEGER"}}},
}

// migrate brings a project database up to the current schema. It is
// idempotent: new tables use IF NOT EXISTS and columns are added only when
// missing, so it is safe on fresh, current and older databases alike.
func (d *DB) migrate(ctx context.Context) error {
	if _, err := d.sql.ExecContext(ctx, projectSchema); err != nil {
		return fmt.Errorf("project schema: %w", err)
	}
	for _, t := range columnsAdded {
		have, err := d.columns(ctx, t.table)
		if err != nil {
			return err
		}
		for _, c := range t.columns {
			if have[c.name] {
				continue
			}
			if _, err := d.sql.ExecContext(ctx, "ALTER TABLE "+t.table+" ADD COLUMN "+c.name+" "+c.ddl); err != nil {
				return fmt.Errorf("add %s.%s: %w", t.table, c.name, err)
			}
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
