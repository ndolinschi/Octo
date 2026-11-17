package projectstore

import (
	"context"
	"database/sql"
)

// Statuses of a command run.
const (
	RunRunning = "running"
	// RunFinished: the process ended by itself (ExitCode says how).
	RunFinished = "finished"
	// RunStopped: the user stopped it (ExitCode is -1 when a signal ended it).
	RunStopped = "stopped"
	// RunError: it could not be started, or the harness stopped while it ran.
	RunError = "error"
)

// CommandRun is one run of a project command, started by the user.
type CommandRun struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Command string `json:"command"`
	// PID is the OS process id while Status is "running"; omitted once finished.
	PID      int    `json:"pid,omitempty"`
	Cwd      string `json:"cwd"`
	ReviewID string `json:"review_id,omitempty"`
	Status   string `json:"status"`
	// ExitCode is null while running; -1 when a signal ended the process.
	ExitCode   *int   `json:"exit_code"`
	StartedAt  string `json:"started_at"`
	FinishedAt string `json:"finished_at,omitempty"`
	DurationMS int64  `json:"duration_ms"`
	// OutputBytes is how much output the run produced; Truncated: it went past the cap and the rest was dropped.
	OutputBytes int64 `json:"output_bytes"`
	Truncated   bool  `json:"truncated"`
	// Tail is the end of the output (stdout and stderr in arrival order); only returned for one run.
	Tail string `json:"tail,omitempty"`
}

const runCols = `id, name, command, cwd, review_id, status, exit_code, started_at, finished_at, duration_ms, output_bytes, truncated`

func scanRun(r scanner, withTail bool) (CommandRun, error) {
	var c CommandRun
	var exit sql.NullInt64
	var trunc int
	dest := []any{&c.ID, &c.Name, &c.Command, &c.Cwd, &c.ReviewID, &c.Status, &exit, &c.StartedAt, &c.FinishedAt, &c.DurationMS, &c.OutputBytes, &trunc}
	if withTail {
		dest = append(dest, &c.Tail)
	}
	if err := r.Scan(dest...); err != nil {
		return c, err
	}
	if exit.Valid {
		n := int(exit.Int64)
		c.ExitCode = &n
	}
	c.Truncated = trunc != 0
	return c, nil
}

// AddRun stores a started run.
func (d *DB) AddRun(ctx context.Context, c CommandRun) error {
	_, err := d.sql.ExecContext(ctx, `INSERT INTO command_runs (id, name, command, cwd, review_id, status, started_at) VALUES (?,?,?,?,?,?,?)`,
		c.ID, c.Name, c.Command, c.Cwd, c.ReviewID, c.Status, c.StartedAt)
	return err
}

// FinishRun records how a run ended and the tail of its output.
func (d *DB) FinishRun(ctx context.Context, c CommandRun) error {
	var exit any
	if c.ExitCode != nil {
		exit = *c.ExitCode
	}
	trunc := 0
	if c.Truncated {
		trunc = 1
	}
	_, err := d.sql.ExecContext(ctx, `UPDATE command_runs SET status = ?, exit_code = ?, finished_at = ?, duration_ms = ?, output_bytes = ?, truncated = ?, tail = ? WHERE id = ?`,
		c.Status, exit, c.FinishedAt, c.DurationMS, c.OutputBytes, trunc, c.Tail, c.ID)
	return err
}

// Run returns one run with its output tail.
func (d *DB) Run(ctx context.Context, id string) (CommandRun, error) {
	c, err := scanRun(d.sql.QueryRowContext(ctx, `SELECT `+runCols+`, tail FROM command_runs WHERE id = ?`, id), true)
	if err == sql.ErrNoRows {
		return c, ErrNotFound
	}
	return c, err
}

// Runs lists runs, newest first (no tails); reviewID "" = all, limit <= 0 = 100.
func (d *DB) Runs(ctx context.Context, reviewID string, limit int) ([]CommandRun, error) {
	if limit <= 0 {
		limit = 100
	}
	q := `SELECT ` + runCols + ` FROM command_runs`
	var args []any
	if reviewID != "" {
		q += ` WHERE review_id = ?`
		args = append(args, reviewID)
	}
	q += ` ORDER BY started_at DESC, rowid DESC LIMIT ?`
	args = append(args, limit)
	rows, err := d.sql.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CommandRun{}
	for rows.Next() {
		c, err := scanRun(rows, false)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// TrimRuns keeps the newest keep finished runs (running ones are never deleted).
func (d *DB) TrimRuns(ctx context.Context, keep int) error {
	_, err := d.sql.ExecContext(ctx, `DELETE FROM command_runs WHERE status != 'running' AND id NOT IN
		(SELECT id FROM command_runs ORDER BY started_at DESC, rowid DESC LIMIT ?)`, keep)
	return err
}
