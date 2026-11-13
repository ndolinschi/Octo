package projectstore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
)

// Schema 7 additions of parity part 2 (modes, plans, rewind, manual compaction).
// Columns are listed in columnsAdded; this table is created idempotently.
const plansSchema = `
CREATE TABLE IF NOT EXISTS plans (
	id TEXT PRIMARY KEY,
	turn_id INTEGER NOT NULL,
	text TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending',
	created_at TEXT NOT NULL,
	approved_at TEXT
);
CREATE INDEX IF NOT EXISTS plans_created ON plans (created_at);`

// Modes of a project or turn.
const (
	ModeAgent = "agent"
	ModeAsk   = "ask"
	ModePlan  = "plan"
)

// ValidMode reports whether m is a mode.
func ValidMode(m string) bool { return m == ModeAgent || m == ModeAsk || m == ModePlan }

// Plan statuses.
const (
	PlanPending  = "pending"
	PlanApproved = "approved"
)

// Plan is the result of a turn that ran in plan mode.
type Plan struct {
	ID         string  `json:"id"`
	TurnID     int64   `json:"turn_id"`
	Text       string  `json:"text"`
	Status     string  `json:"status"`
	CreatedAt  string  `json:"created_at"`
	ApprovedAt *string `json:"approved_at"`
}

// AddPlan stores a plan for the turn.
func (d *DB) AddPlan(ctx context.Context, turnID int64, text string) (Plan, error) {
	p := Plan{ID: NewID("pln"), TurnID: turnID, Text: text, Status: PlanPending, CreatedAt: Now()}
	_, err := d.sql.ExecContext(ctx, `INSERT INTO plans (id, turn_id, text, status, created_at) VALUES (?, ?, ?, ?, ?)`,
		p.ID, p.TurnID, p.Text, p.Status, p.CreatedAt)
	return p, err
}

func scanPlan(sc interface{ Scan(...any) error }) (Plan, error) {
	var p Plan
	var ap sql.NullString
	if err := sc.Scan(&p.ID, &p.TurnID, &p.Text, &p.Status, &p.CreatedAt, &ap); err != nil {
		return p, err
	}
	if ap.Valid {
		p.ApprovedAt = &ap.String
	}
	return p, nil
}

const planCols = `id, turn_id, text, status, created_at, approved_at`

// Plan returns one plan.
func (d *DB) Plan(ctx context.Context, id string) (Plan, error) {
	p, err := scanPlan(d.sql.QueryRowContext(ctx, `SELECT `+planCols+` FROM plans WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return p, ErrNotFound
	}
	return p, err
}

// LatestPlan is the newest plan; ErrNotFound when there is none.
func (d *DB) LatestPlan(ctx context.Context) (Plan, error) {
	p, err := scanPlan(d.sql.QueryRowContext(ctx, `SELECT `+planCols+` FROM plans ORDER BY created_at DESC, rowid DESC LIMIT 1`))
	if errors.Is(err, sql.ErrNoRows) {
		return p, ErrNotFound
	}
	return p, err
}

// ApprovePlan marks a pending plan approved; ErrNotFound for an unknown id and
// ErrPlanNotPending when it was approved already.
func (d *DB) ApprovePlan(ctx context.Context, id string) (Plan, error) {
	res, err := d.sql.ExecContext(ctx, `UPDATE plans SET status = ?, approved_at = ? WHERE id = ? AND status = ?`,
		PlanApproved, Now(), id, PlanPending)
	if err != nil {
		return Plan{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		if _, err := d.Plan(ctx, id); err != nil {
			return Plan{}, err
		}
		return Plan{}, ErrPlanNotPending
	}
	return d.Plan(ctx, id)
}

// ErrPlanNotPending: the plan was approved before.
var ErrPlanNotPending = errors.New("projectstore: plan is not pending")

// AddManualCompaction stores a summary made on request as covering the
// agent's messages so far; count is how many messages it replaces.
func (d *DB) AddManualCompaction(ctx context.Context, agentID, summary string, count int) (Compaction, error) {
	c, err := d.AddCompaction(ctx, agentID, summary)
	if err != nil {
		return c, err
	}
	_, err = d.sql.ExecContext(ctx, `UPDATE compactions SET manual = 1, message_count = ? WHERE id = ?`, count, c.ID)
	c.Manual, c.MessageCount = true, count
	return c, err
}

// LastUsage is the newest API usage row of the agent's main thread.
type LastUsage struct {
	Input, CacheRead, CacheWrite, Output int64
	Model                                string
}

// LastAgentUsage returns the agent's newest main-thread usage row (side
// questions and other roles never count); ok is false when there is none.
func (d *DB) LastAgentUsage(ctx context.Context, agentID string) (u LastUsage, ok bool, err error) {
	err = d.sql.QueryRowContext(ctx,
		`SELECT model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens FROM usage
		 WHERE agent_id = ? AND role IS NULL ORDER BY id DESC LIMIT 1`, agentID).
		Scan(&u.Model, &u.Input, &u.CacheRead, &u.CacheWrite, &u.Output)
	if errors.Is(err, sql.ErrNoRows) {
		return u, false, nil
	}
	return u, err == nil, err
}

// RewindResult is what a rewind cut.
type RewindResult struct {
	MessagesCut   int
	AgentsCut     int
	TasksDropped  int
	ChangesPurged int
}

// Rewind cuts the conversation back to just before message fromID: every
// message with that id or a later one (of every agent) is soft-deleted (kept
// on disk with rewound_at), sub-agents created since are hidden the same way,
// their search documents, the task records and facts of the cut turns, their
// recorded changes, context receipts, compactions that reach into the cut and
// plans are removed. The caller has checked and restored the files.
func (d *DB) Rewind(ctx context.Context, fromID int64) (RewindResult, error) {
	var res RewindResult
	var created string
	if err := d.sql.QueryRowContext(ctx, `SELECT created_at FROM messages WHERE id = ?`, fromID).Scan(&created); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return res, ErrNotFound
		}
		return res, err
	}
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return res, err
	}
	defer func() { _ = tx.Rollback() }()
	now := Now()
	rows, err := tx.QueryContext(ctx, `SELECT id FROM messages WHERE id >= ? AND rewound_at IS NULL`, fromID)
	if err != nil {
		return res, err
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return res, err
		}
		ids = append(ids, id)
	}
	if err := rows.Close(); err != nil {
		return res, err
	}
	for _, id := range ids {
		if err := delDoc(ctx, tx, DocMessage, itoa(id)); err != nil {
			return res, err
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE messages SET rewound_at = ? WHERE id >= ? AND rewound_at IS NULL`, now, fromID); err != nil {
		return res, err
	}
	res.MessagesCut = len(ids)
	r, err := tx.ExecContext(ctx, `UPDATE agents SET rewound_at = ? WHERE parent_id IS NOT NULL AND created_at >= ? AND rewound_at IS NULL`, now, created)
	if err != nil {
		return res, err
	}
	n, _ := r.RowsAffected()
	res.AgentsCut = int(n)
	for _, q := range []string{
		`DELETE FROM context_receipts WHERE turn_id >= ?`,
		`DELETE FROM compactions WHERE upto_message_id >= ?`,
		`DELETE FROM plans WHERE turn_id >= ?`,
	} {
		if _, err := tx.ExecContext(ctx, q, fromID); err != nil {
			return res, err
		}
	}
	r, err = tx.ExecContext(ctx, `DELETE FROM changes WHERE turn_id >= ?`, fromID)
	if err != nil {
		return res, err
	}
	n, _ = r.RowsAffected()
	res.ChangesPurged = int(n)
	if err := tx.Commit(); err != nil {
		return res, err
	}
	dropped, err := d.dropTaskRefs(ctx, fromID)
	res.TasksDropped = dropped
	if err != nil {
		return res, err
	}
	return res, d.Touch(ctx)
}

// dropTaskRefs deletes the task records created by the cut turns (every message
// they reference is cut) and removes the references to cut messages from the
// others (message ids, quotes, facts).
func (d *DB) dropTaskRefs(ctx context.Context, fromID int64) (int, error) {
	tasks, err := d.Tasks(ctx)
	if err != nil {
		return 0, err
	}
	dropped := 0
	for _, t := range tasks {
		if len(t.MessageIDs) == 0 {
			continue
		}
		keep := slices.DeleteFunc(slices.Clone(t.MessageIDs), func(id int64) bool { return id >= fromID })
		if len(keep) == len(t.MessageIDs) {
			continue
		}
		if len(keep) == 0 {
			if err := d.DeleteTask(ctx, t.ID); err != nil {
				return dropped, fmt.Errorf("drop task %s: %w", t.ID, err)
			}
			dropped++
			continue
		}
		t.MessageIDs = keep
		t.Quotes = slices.DeleteFunc(t.Quotes, func(q Quote) bool { return q.MessageID >= fromID })
		t.Facts = slices.DeleteFunc(t.Facts, func(f Fact) bool { return f.MessageID >= fromID })
		if _, err := d.SaveTask(ctx, t); err != nil {
			return dropped, err
		}
	}
	return dropped, nil
}

func orAgentMode(m string) string {
	if ValidMode(m) {
		return m
	}
	return ModeAgent
}

// CountCut says how many messages and sub-agents a Rewind to fromID would hide.
func (d *DB) CountCut(ctx context.Context, fromID int64) (messages, agents int, err error) {
	var created string
	if err = d.sql.QueryRowContext(ctx, `SELECT created_at FROM messages WHERE id = ?`, fromID).Scan(&created); err != nil {
		return 0, 0, err
	}
	if err = d.sql.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages WHERE id >= ? AND rewound_at IS NULL`, fromID).Scan(&messages); err != nil {
		return
	}
	err = d.sql.QueryRowContext(ctx, `SELECT COUNT(*) FROM agents WHERE parent_id IS NOT NULL AND created_at >= ? AND rewound_at IS NULL`, created).Scan(&agents)
	return
}
