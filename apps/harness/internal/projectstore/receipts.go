package projectstore

import (
	"context"
	"database/sql"
	"errors"
)

// SaveReceipt stores the context receipt of a turn (replacing an earlier one).
func (d *DB) SaveReceipt(ctx context.Context, turnID int64, mode, receiptJSON string) error {
	_, err := d.sql.ExecContext(ctx, `INSERT INTO context_receipts (turn_id, mode, receipt_json, created_at) VALUES (?, ?, ?, ?)
		ON CONFLICT(turn_id) DO UPDATE SET mode = excluded.mode, receipt_json = excluded.receipt_json, created_at = excluded.created_at`,
		turnID, mode, receiptJSON, Now())
	return err
}

// Receipt returns the stored receipt JSON of a turn.
func (d *DB) Receipt(ctx context.Context, turnID int64) (string, error) {
	var s string
	err := d.sql.QueryRowContext(ctx, `SELECT receipt_json FROM context_receipts WHERE turn_id = ?`, turnID).Scan(&s)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return s, err
}
