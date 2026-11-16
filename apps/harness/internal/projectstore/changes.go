package projectstore

import (
	"context"
	"database/sql"
	"errors"
)

// Kinds of a change.
const (
	ChangeCreated  = "created"
	ChangeModified = "modified"
	ChangeDeleted  = "deleted"
)

// Reasons a change has no diff (Change.Note); "" means it has one.
const (
	NoteBinary     = "binary"
	NoteTooLarge   = "too_large"
	NoteNoPreimage = "no_preimage"
	NotePruned     = "pruned"
)

// Change is one recorded file change: the content before and after are the
// blobs named by the hashes. A hash is set whenever the content existed and
// could be hashed; the blob only when it was text within the size limit.
type Change struct {
	ID         int64
	TurnID     int64
	AgentID    string
	Folder     string
	Path       string
	Kind       string
	BeforeHash *string
	AfterHash  *string
	Added      *int
	Removed    *int
	Note       string
	Source     string
	ToolUseID  string
	CreatedAt  string
	// SessionID is the main session of the agent that made the change; WorkspaceID where it was made and
	// Attribution how sure that is ("exact" until worktrees and shared windows are built). Schema 15.
	SessionID   string
	WorkspaceID string
	Attribution string
}

// NewChange is a change to record with the blobs to store beside it (nil: the
// content is not kept).
type NewChange struct {
	Change
	BeforeBlob, AfterBlob []byte
}

const changeCols = `id, turn_id, agent_id, folder, path, kind, before_hash, after_hash, added, removed, note, source, tool_use_id, created_at, session_id, workspace_id, attribution`

// AddChange stores the change and its blobs in one transaction.
func (d *DB) AddChange(ctx context.Context, nc NewChange) (Change, error) {
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return Change{}, err
	}
	defer func() { _ = tx.Rollback() }()
	for _, b := range []struct {
		hash *string
		data []byte
	}{{nc.BeforeHash, nc.BeforeBlob}, {nc.AfterHash, nc.AfterBlob}} {
		if b.hash == nil || b.data == nil {
			continue
		}
		if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO blobs (hash, content) VALUES (?, ?)`, *b.hash, b.data); err != nil {
			return Change{}, err
		}
	}
	c := nc.Change
	if c.CreatedAt == "" {
		c.CreatedAt = Now()
	}
	if c.WorkspaceID == "" {
		c.WorkspaceID = SharedWorkspace
	}
	res, err := tx.ExecContext(ctx,
		`INSERT INTO changes (turn_id, agent_id, folder, path, kind, before_hash, after_hash, added, removed, note, source, tool_use_id, created_at, session_id, workspace_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(NULLIF(?, ''), (SELECT NULLIF(session_id, '') FROM agents WHERE id = ?),
			(SELECT NULLIF(session_id, '') FROM messages WHERE id = ?), ''), COALESCE(NULLIF(?, ''), 'shared'))`,
		c.TurnID, c.AgentID, c.Folder, c.Path, c.Kind, c.BeforeHash, c.AfterHash, c.Added, c.Removed, c.Note, c.Source, c.ToolUseID, c.CreatedAt,
		c.SessionID, c.AgentID, c.TurnID, c.WorkspaceID)
	if err != nil {
		return Change{}, err
	}
	if c.ID, err = res.LastInsertId(); err != nil {
		return Change{}, err
	}
	return c, tx.Commit()
}

func scanChange(sc interface{ Scan(...any) error }) (Change, error) {
	var c Change
	var bh, ah sql.NullString
	var added, removed sql.NullInt64
	if err := sc.Scan(&c.ID, &c.TurnID, &c.AgentID, &c.Folder, &c.Path, &c.Kind, &bh, &ah, &added, &removed,
		&c.Note, &c.Source, &c.ToolUseID, &c.CreatedAt, &c.SessionID, &c.WorkspaceID, &c.Attribution); err != nil {
		return c, err
	}
	if bh.Valid {
		c.BeforeHash = &bh.String
	}
	if ah.Valid {
		c.AfterHash = &ah.String
	}
	if added.Valid {
		n := int(added.Int64)
		c.Added = &n
	}
	if removed.Valid {
		n := int(removed.Int64)
		c.Removed = &n
	}
	return c, nil
}

// Changes lists changes oldest first: one turn's when turnID > 0, else all.
func (d *DB) Changes(ctx context.Context, turnID int64) ([]Change, error) {
	q, args := `SELECT `+changeCols+` FROM changes ORDER BY id`, []any{}
	if turnID > 0 {
		q, args = `SELECT `+changeCols+` FROM changes WHERE turn_id = ? ORDER BY id`, []any{turnID}
	}
	rows, err := d.sql.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Change{}
	for rows.Next() {
		c, err := scanChange(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// Change returns one change.
func (d *DB) Change(ctx context.Context, id int64) (Change, error) {
	c, err := scanChange(d.sql.QueryRowContext(ctx, `SELECT `+changeCols+` FROM changes WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return c, ErrNotFound
	}
	return c, err
}

// Blob returns stored content by hash.
func (d *DB) Blob(ctx context.Context, hash string) (string, bool, error) {
	var b []byte
	err := d.sql.QueryRowContext(ctx, `SELECT content FROM blobs WHERE hash = ?`, hash).Scan(&b)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return string(b), err == nil, err
}

// HasBlob reports whether the hash has stored content.
func (d *DB) HasBlob(ctx context.Context, hash string) (bool, error) {
	var one int
	err := d.sql.QueryRowContext(ctx, `SELECT 1 FROM blobs WHERE hash = ?`, hash).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// PruneBlobs deletes blobs no change newer than cutoff (a Stamp) refers to:
// the rows of older changes stay, their diffs are gone. It returns the number
// of blobs deleted.
func (d *DB) PruneBlobs(ctx context.Context, cutoff string) (int64, error) {
	res, err := d.sql.ExecContext(ctx, `DELETE FROM blobs WHERE hash NOT IN (
		SELECT before_hash FROM changes WHERE before_hash IS NOT NULL AND created_at >= ?
		UNION SELECT after_hash FROM changes WHERE after_hash IS NOT NULL AND created_at >= ?)`, cutoff, cutoff)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
