package projectstore

import (
	"context"
	"database/sql"
	"strings"
)

// setter builds a partial UPDATE from optional fields.
type setter struct {
	cols []string
	args []any
}

func newSetter() *setter { return &setter{} }

func (s *setter) add(col string, v any) {
	s.cols = append(s.cols, col+" = ?")
	s.args = append(s.args, v)
}

func (s *setter) str(col string, v *string) {
	if v != nil {
		s.add(col, *v)
	}
}

func (s *setter) exec(ctx context.Context, db *sql.DB, table, where string, whereArgs ...any) error {
	if len(s.cols) == 0 {
		return nil
	}
	q := "UPDATE " + table + " SET " + strings.Join(s.cols, ", ") + " WHERE " + where
	_, err := db.ExecContext(ctx, q, append(s.args, whereArgs...)...)
	return err
}
