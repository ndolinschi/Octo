package projectstore

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/notemd"
)

const noteCols = `id, title, content, author, created_at, updated_at, description, description_auto, tags_json, pinned, last_read_at, read_count`

func scanNote(r scanner) (Note, error) {
	var n Note
	var tags string
	err := r.Scan(&n.ID, &n.Title, &n.Content, &n.Author, &n.CreatedAt, &n.UpdatedAt,
		&n.Description, &n.DescriptionAuto, &tags, &n.Pinned, &n.LastReadAt, &n.ReadCount)
	n.Tags = []string{}
	if tags != "" {
		_ = json.Unmarshal([]byte(tags), &n.Tags)
	}
	if n.Tags == nil {
		n.Tags = []string{}
	}
	n.Size = len([]rune(n.Content))
	return n, err
}

// NoteFields are the fields of a note a writer sets.
type NoteFields struct {
	Title       string
	Description string // empty: derived from the body (and flagged auto)
	Tags        []string
	Pinned      bool
	Body        string
}

// NotePatch changes some fields of a note; nil leaves a field as it is.
type NotePatch struct {
	Title       *string
	Description *string // an empty string asks for the derived description
	Tags        *[]string
	Pinned      *bool
	Body        *string
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

// CreateNote stores a note with the body as it is and a description derived from it.
func (d *DB) CreateNote(ctx context.Context, title, content string, author NoteAuthor) (Note, error) {
	return d.InsertNote(ctx, NoteFields{Title: title, Body: content}, author)
}

// InsertNote stores a new note. An empty description is derived from the body.
func (d *DB) InsertNote(ctx context.Context, f NoteFields, author NoteAuthor) (Note, error) {
	id, now := NewID("nte"), Now()
	desc, auto := strings.TrimSpace(f.Description), false
	if desc == "" {
		desc, auto = notemd.AutoDescription(f.Body), true
	}
	tags, _ := json.Marshal(notemd.NormalizeTags(f.Tags))
	_, err := d.sql.ExecContext(ctx,
		`INSERT INTO notes (id, title, content, author, created_at, updated_at, description, description_auto, tags_json, pinned)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, f.Title, f.Body, string(author), now, now, desc, auto, string(tags), f.Pinned)
	if err != nil {
		return Note{}, err
	}
	n, err := d.Note(ctx, id)
	if err != nil {
		return n, err
	}
	if err := putDoc(ctx, d.sql, noteDoc(n)); err != nil {
		return Note{}, err
	}
	if err := d.Touch(ctx); err != nil {
		return Note{}, err
	}
	return n, nil
}

func (d *DB) UpdateNote(ctx context.Context, id string, title, content *string) (Note, error) {
	return d.PatchNote(ctx, id, NotePatch{Title: title, Body: content})
}

// PatchNote changes a note. A description given explicitly is kept as written;
// when it is not given and the body changes, an automatic description follows
// the body.
func (d *DB) PatchNote(ctx context.Context, id string, p NotePatch) (Note, error) {
	cur, err := d.Note(ctx, id)
	if err != nil {
		return Note{}, err
	}
	set := newSetter()
	set.str("title", p.Title)
	set.str("content", p.Body)
	switch {
	case p.Description != nil && strings.TrimSpace(*p.Description) != "":
		set.add("description", strings.TrimSpace(*p.Description))
		set.add("description_auto", false)
	case p.Description != nil || (p.Body != nil && cur.DescriptionAuto):
		body := cur.Content
		if p.Body != nil {
			body = *p.Body
		}
		set.add("description", notemd.AutoDescription(body))
		set.add("description_auto", true)
	}
	if p.Tags != nil {
		raw, _ := json.Marshal(notemd.NormalizeTags(*p.Tags))
		set.add("tags_json", string(raw))
	}
	if p.Pinned != nil {
		set.add("pinned", *p.Pinned)
	}
	set.add("updated_at", Now())
	if err := set.exec(ctx, d.sql, "notes", "id = ?", id); err != nil {
		return Note{}, err
	}
	n, err := d.Note(ctx, id)
	if err != nil {
		return n, err
	}
	if err := putDoc(ctx, d.sql, noteDoc(n)); err != nil {
		return Note{}, err
	}
	if err := d.Touch(ctx); err != nil {
		return Note{}, err
	}
	return n, nil
}

// ReadNote returns a note and records the read (last_read_at, read_count).
func (d *DB) ReadNote(ctx context.Context, id string) (Note, error) {
	res, err := d.sql.ExecContext(ctx, `UPDATE notes SET last_read_at = ?, read_count = read_count + 1 WHERE id = ?`, Now(), id)
	if err != nil {
		return Note{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return Note{}, ErrNotFound
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
	if err := delDoc(ctx, d.sql, DocNote, id); err != nil {
		return err
	}
	return d.Touch(ctx)
}

// NoteHit is a note found by SearchNotes.
type NoteHit struct {
	Note
	// Snippet is a piece of the body (or the description) around the match.
	Snippet string `json:"snippet"`
}

// SearchNotes finds notes by their title, description and body, with the
// tokenizers of the memory search (exact words, stems, substrings).
func (d *DB) SearchNotes(ctx context.Context, query string, limit int) ([]NoteHit, error) {
	hits, err := d.Search(ctx, SearchQuery{Text: query, Kinds: []string{DocNote}, Limit: limit})
	if err != nil {
		return nil, err
	}
	var out []NoteHit
	for _, h := range hits {
		n, err := d.Note(ctx, h.Ref)
		if err == ErrNotFound {
			continue
		}
		if err != nil {
			return nil, err
		}
		out = append(out, NoteHit{Note: n, Snippet: snippetAround(n.Content+"\n"+n.Description, Terms(query), 160)})
	}
	return out, nil
}

// noteDoc is the search document of a note: the title, and the description
// followed by the body as the text.
func noteDoc(n Note) Doc {
	return Doc{Kind: DocNote, Ref: n.ID, Title: n.Title, Body: n.Description + "\n" + n.Content, Date: n.UpdatedAt}
}

// snippetAround cuts at most n characters of text around the first term that occurs.
func snippetAround(text string, terms []string, n int) string {
	text = strings.Join(strings.Fields(text), " ")
	lower := strings.ToLower(text)
	at := -1
	for _, t := range terms {
		for _, cand := range []string{t, Stem(t)} {
			if i := strings.Index(lower, cand); i >= 0 && (at < 0 || i < at) {
				at = i
			}
		}
	}
	r := []rune(text)
	start := 0
	if at > 0 {
		start = len([]rune(lower[:at])) - n/3
	}
	start = max(start, 0)
	end := min(start+n, len(r))
	s := string(r[start:end])
	if start > 0 {
		s = "…" + s
	}
	if end < len(r) {
		s += "…"
	}
	return s
}
