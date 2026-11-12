package projectstore

import (
	"context"
	"fmt"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/notemd"
)

// Schema 10 (M5, notes as Markdown with descriptions) adds the front-matter
// fields to notes: description (one line, at most 200 characters; the model
// sees only this until it opens the note), description_auto (the description
// was derived from the body), tags, pinned, last_read_at and read_count. It is
// its own file and function so the number can be renumbered when migrations
// from parallel work are merged. Existing notes get a description from the
// first non-empty line of their body, flagged automatic, a title from that line
// when they had none, and a search document.
const notesSchemaVersion = 10

var notesColumns = []column{
	{"description", "TEXT NOT NULL DEFAULT ''"},
	{"description_auto", "INTEGER NOT NULL DEFAULT 0"},
	{"tags_json", "TEXT NOT NULL DEFAULT '[]'"},
	{"pinned", "INTEGER NOT NULL DEFAULT 0"},
	{"last_read_at", "TEXT NOT NULL DEFAULT ''"},
	{"read_count", "INTEGER NOT NULL DEFAULT 0"},
}

func (d *DB) migrateV10Notes(ctx context.Context) error {
	have, err := d.columns(ctx, "notes")
	if err != nil {
		return err
	}
	fresh := !have["description"]
	for _, c := range notesColumns {
		if have[c.name] {
			continue
		}
		if _, err := d.sql.ExecContext(ctx, "ALTER TABLE notes ADD COLUMN "+c.name+" "+c.ddl); err != nil {
			return fmt.Errorf("add notes.%s (v%d): %w", c.name, notesSchemaVersion, err)
		}
	}
	if !fresh {
		return nil
	}
	rows, err := d.sql.QueryContext(ctx, `SELECT id, title, content FROM notes`)
	if err != nil {
		return err
	}
	type row struct{ id, title, content string }
	var all []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.id, &r.title, &r.content); err != nil {
			_ = rows.Close()
			return err
		}
		all = append(all, r)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, r := range all {
		title := strings.TrimSpace(r.title)
		desc := notemd.AutoDescription(r.content)
		if title == "" {
			title = notemd.Clip(desc, notemd.MaxTitle)
		}
		if _, err := d.sql.ExecContext(ctx, `UPDATE notes SET title = ?, description = ?, description_auto = 1 WHERE id = ?`, title, desc, r.id); err != nil {
			return err
		}
		n, err := d.Note(ctx, r.id)
		if err != nil {
			return err
		}
		if err := putDoc(ctx, d.sql, noteDoc(n)); err != nil {
			return err
		}
	}
	return nil
}
