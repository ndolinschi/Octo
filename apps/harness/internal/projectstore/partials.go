package projectstore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// The text an agent is streaming is not a message until the model's answer
// (or the cut of a stop or a failure) is stored whole. So that a crash or a
// kill of the harness does not lose what was already on screen, the sink
// writes it here at a bounded rate while it streams (one row per agent,
// replaced each time) and removes the row once the message is stored. When the
// harness starts, a row that is newer than the agent's last message is what a
// turn the previous process left running had written; it becomes that agent's
// stopped assistant message (orchestrator.RecoverInterrupted).
//
// turn_alive holds one row, the last time a running turn said it was alive
// (written every few seconds while one runs): how long a turn ran that was cut
// while nothing was written (a long tool call, a sub-agent at work).
//
// No schema version of their own: the tables are empty whenever no turn runs,
// and an older binary that opens the database never reads them.
const partialsSchema = `
CREATE TABLE IF NOT EXISTS partials (
	agent_id TEXT PRIMARY KEY,
	text TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS turn_alive (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	at TEXT NOT NULL
);
`

func (d *DB) migratePartials(ctx context.Context) error {
	if _, err := d.sql.ExecContext(ctx, partialsSchema); err != nil {
		return fmt.Errorf("partials schema: %w", err)
	}
	return nil
}

// Partial is the streamed text of an agent's unfinished message as last checkpointed.
type Partial struct {
	AgentID   string
	Text      string
	UpdatedAt string
}

// SavePartial replaces the agent's checkpointed text.
func (d *DB) SavePartial(ctx context.Context, agentID, text string) error {
	_, err := d.sql.ExecContext(ctx,
		`INSERT INTO partials (agent_id, text, updated_at) VALUES (?, ?, ?)
		ON CONFLICT(agent_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`, agentID, text, Now())
	return err
}

// ClearPartial removes the agent's checkpointed text (its message is stored).
func (d *DB) ClearPartial(ctx context.Context, agentID string) error {
	_, err := d.sql.ExecContext(ctx, `DELETE FROM partials WHERE agent_id = ?`, agentID)
	return err
}

// TakePartials returns every checkpoint and removes them all.
func (d *DB) TakePartials(ctx context.Context) ([]Partial, error) {
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	rows, err := tx.QueryContext(ctx, `SELECT agent_id, text, updated_at FROM partials ORDER BY agent_id`)
	if err != nil {
		return nil, err
	}
	var out []Partial
	for rows.Next() {
		var p Partial
		if err := rows.Scan(&p.AgentID, &p.Text, &p.UpdatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM partials`); err != nil {
		return nil, err
	}
	return out, tx.Commit()
}

// TurnAlive records that the running turn is alive now.
func (d *DB) TurnAlive(ctx context.Context) error {
	_, err := d.sql.ExecContext(ctx, `INSERT INTO turn_alive (id, at) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET at = excluded.at`, Now())
	return err
}

// TakeTurnAlive returns the last TurnAlive time ("" when none) and removes it.
func (d *DB) TakeTurnAlive(ctx context.Context) (string, error) {
	var at string
	err := d.sql.QueryRowContext(ctx, `SELECT at FROM turn_alive WHERE id = 1`).Scan(&at)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	_, err = d.sql.ExecContext(ctx, `DELETE FROM turn_alive`)
	return at, err
}
