package projectstore

import (
	"context"
	"database/sql"
)

const noteCols = `id, title, content, author, created_at, updated_at`

func scanNote(r scanner) (Note, error) {
	var n Note
	err := r.Scan(&n.ID, &n.Title, &n.Content, &n.Author, &n.CreatedAt, &n.UpdatedAt)
	return n, err
}

func (d *DB) Notes(ctx context.Context) ([]Note, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT `+noteCols+` FROM notes ORDER BY created_at, rowid`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Note{}
	for rows.Next() {
		n, err := scanNote(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

func (d *DB) Note(ctx context.Context, id string) (Note, error) {
	n, err := scanNote(d.sql.QueryRowContext(ctx, `SELECT `+noteCols+` FROM notes WHERE id = ?`, id))
	if err == sql.ErrNoRows {
		return n, ErrNotFound
	}
	return n, err
}

func (d *DB) NoteByTitle(ctx context.Context, title string) (Note, error) {
	n, err := scanNote(d.sql.QueryRowContext(ctx,
		`SELECT `+noteCols+` FROM notes WHERE title = ? ORDER BY created_at, rowid LIMIT 1`, title))
	if err == sql.ErrNoRows {
		return n, ErrNotFound
	}
	return n, err
}

func (d *DB) CreateNote(ctx context.Context, title, content string, author NoteAuthor) (Note, error) {
	id, now := NewID("nte"), Now()
	_, err := d.sql.ExecContext(ctx,
		`INSERT INTO notes (id, title, content, author, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
		id, title, content, string(author), now, now)
	if err != nil {
		return Note{}, err
	}
	if err := d.Touch(ctx); err != nil {
		return Note{}, err
	}
	return d.Note(ctx, id)
}

func (d *DB) UpdateNote(ctx context.Context, id string, title, content *string) (Note, error) {
	if _, err := d.Note(ctx, id); err != nil {
		return Note{}, err
	}
	set := newSetter()
	set.str("title", title)
	set.str("content", content)
	set.add("updated_at", Now())
	if err := set.exec(ctx, d.sql, "notes", "id = ?", id); err != nil {
		return Note{}, err
	}
	if err := d.Touch(ctx); err != nil {
		return Note{}, err
	}
	return d.Note(ctx, id)
}

func (d *DB) DeleteNote(ctx context.Context, id string) error {
	res, err := d.sql.ExecContext(ctx, `DELETE FROM notes WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return d.Touch(ctx)
}
