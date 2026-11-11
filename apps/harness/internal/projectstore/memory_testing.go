package projectstore

import (
	"context"
	"fmt"
	"strings"
)

// Helpers for tests of packages that sit on the store (they bypass the
// normal write paths on purpose).

// Exec_ runs a statement.
func (d *DB) Exec_(ctx context.Context, q string, args ...any) error {
	_, err := d.sql.ExecContext(ctx, q, args...)
	return err
}

// BackfillForTest indexes every stored message, as a migration does.
func (d *DB) BackfillForTest(ctx context.Context) error { return d.backfillMessages(ctx) }

// PutFileForTest stores a tiny memory file.
func (d *DB) PutFileForTest(ctx context.Context, path string) error {
	_, err := d.PutFile(ctx, MemoryFile{Path: path, Summary: "s", Content: "x"})
	return err
}

// DumpForTest returns every row of a table as text.
func (d *DB) DumpForTest(ctx context.Context, table string) (string, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT * FROM `+table)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	cols, _ := rows.Columns()
	var b strings.Builder
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return "", err
		}
		fmt.Fprintln(&b, vals...)
	}
	return b.String(), rows.Err()
}
