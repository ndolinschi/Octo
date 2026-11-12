package projectstore

import "context"

// exchangeIDsOf lists the exchanges that worked on a task, oldest first.
func (d *DB) exchangeIDsOf(ctx context.Context, taskID string) []string {
	return d.exchangeIDsByTask(ctx)[taskID]
}

// exchangeIDsByTask maps task ids to their exchanges. A read never fails for
// this: a missing table or a failed query gives none.
func (d *DB) exchangeIDsByTask(ctx context.Context) map[string][]string {
	rows, err := d.sql.QueryContext(ctx, `SELECT task_id, id FROM exchanges WHERE task_id != '' AND removed = 0 ORDER BY started_at, rowid`)
	if err != nil {
		return nil
	}
	defer rows.Close()
	out := map[string][]string{}
	for rows.Next() {
		var t, e string
		if rows.Scan(&t, &e) == nil {
			out[t] = append(out[t], e)
		}
	}
	return out
}

// AttachExchangeTask points the exchange of a turn at the task it worked on
// ("" detaches it). It reports whether an exchange was found.
func (d *DB) AttachExchangeTask(ctx context.Context, turnID int64, taskID string) (bool, error) {
	res, err := d.sql.ExecContext(ctx, `UPDATE exchanges SET task_id = ? WHERE turn_id = ?`, taskID, turnID)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}
