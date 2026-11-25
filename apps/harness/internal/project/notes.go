package project

import (
	"context"
	"errors"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/notemd"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// Notes manages project notes and announces every change.
type Notes struct {
	store *projectstore.Store
	hub   *events.Hub
}

func NewNotes(store *projectstore.Store, hub *events.Hub) *Notes {
	return &Notes{store: store, hub: hub}
}

func (n *Notes) db(ctx context.Context, pid string) (*projectstore.DB, error) {
	db, err := n.store.Get(ctx, pid)
	if errors.Is(err, projectstore.ErrNotFound) {
		return nil, notFound("project")
	}
	return db, err
}

// changed announces a change. The event carries the note without its body: a
// client that shows the body fetches it.
func (n *Notes) changed(pid, id string, note *projectstore.Note) {
	var payload any
	if note != nil {
		payload = WithoutBody(*note)
	}
	n.hub.Publish(pid, events.NoteChanged, map[string]any{"note": payload, "note_id": id})
	n.hub.Publish(pid, events.ContextUpdated, map[string]any{"project_id": pid}) // the notes are part of the context
}

// WithoutBody is the note as a list shows it.
func WithoutBody(n projectstore.Note) projectstore.Note {
	n.Content = ""
	return n
}

// Markdown is the note's source: front matter and body.
func Markdown(n projectstore.Note) string {
	return notemd.Serialize(notemd.Doc{
		ID: n.ID, Title: n.Title, Description: n.Description, DescriptionAuto: n.DescriptionAuto, Tags: n.Tags, Pinned: n.Pinned,
		CreatedAt: n.CreatedAt, UpdatedAt: n.UpdatedAt, LastReadAt: n.LastReadAt, ReadCount: n.ReadCount, Body: n.Content,
	})
}

// List returns every note without its body.
func (n *Notes) List(ctx context.Context, pid string) ([]projectstore.Note, error) {
	db, err := n.db(ctx, pid)
	if err != nil {
		return nil, err
	}
	notes, err := db.Notes(ctx)
	for i := range notes {
		notes[i] = WithoutBody(notes[i])
	}
	return notes, err
}

// Get returns one note with its body; it does not count as a read by an agent.
func (n *Notes) Get(ctx context.Context, pid, id string) (projectstore.Note, error) {
	db, err := n.db(ctx, pid)
	if err != nil {
		return projectstore.Note{}, err
	}
	note, err := db.Note(ctx, id)
	if errors.Is(err, projectstore.ErrNotFound) {
		return note, notFound("note")
	}
	return note, err
}

// Read is what an agent's read_note does: the note, and the read is recorded.
func (n *Notes) Read(ctx context.Context, pid, id string) (projectstore.Note, error) {
	db, err := n.db(ctx, pid)
	if err != nil {
		return projectstore.Note{}, err
	}
	note, err := db.ReadNote(ctx, id)
	if errors.Is(err, projectstore.ErrNotFound) {
		return note, notFound("note")
	}
	return note, err
}

// Search finds notes (title, description, body) for search_notes.
func (n *Notes) Search(ctx context.Context, pid, query string, limit int) ([]projectstore.NoteHit, error) {
	if len(projectstore.Terms(query)) == 0 {
		return nil, invalid("query is required")
	}
	db, err := n.db(ctx, pid)
	if err != nil {
		return nil, err
	}
	return db.SearchNotes(ctx, query, limit)
}

// NoteInput creates a note from fields or from raw Markdown with front matter
// (Markdown wins; a Title is then only the fallback of a source without one).
type NoteInput struct {
	Title       string
	Description string
	Tags        []string
	Pinned      bool
	Content     string
	Markdown    string
}

// resolve turns the input into the fields to store.
func (in NoteInput) resolve() (projectstore.NoteFields, error) {
	f := projectstore.NoteFields{Title: strings.TrimSpace(in.Title), Description: in.Description, Tags: in.Tags, Pinned: in.Pinned, Body: in.Content}
	if in.Markdown != "" {
		d, err := notemd.Parse(in.Markdown)
		if err != nil {
			return f, invalid("markdown: %v", err)
		}
		f.Body = d.Body
		if d.HasFrontMatter {
			f.Title, f.Description, f.Tags, f.Pinned = strings.TrimSpace(d.Title), d.Description, d.Tags, d.Pinned
		} else if f.Title == "" {
			f.Title = headingOf(d.Body)
		}
	}
	return f, check(f.Title, f.Description, f.Tags)
}

func check(title, description string, tags []string) error {
	if err := notemd.Validate(notemd.Doc{Title: title, Description: description, Tags: tags}); err != nil {
		return invalid("%v", err)
	}
	return nil
}

// headingOf is the title of a Markdown document without front matter: its
// first "# " heading, else its first non-empty line.
func headingOf(body string) string {
	first := ""
	for _, l := range strings.Split(body, "\n") {
		l = strings.TrimSpace(l)
		if l == "" {
			continue
		}
		if t, ok := strings.CutPrefix(l, "# "); ok {
			return notemd.Clip(strings.TrimSpace(t), notemd.MaxTitle)
		}
		if first == "" {
			first = notemd.Clip(strings.TrimLeft(l, "# "), notemd.MaxTitle)
		}
	}
	return first
}

// checkPinned verifies the pin limits with the note (id, "" for a new one) as
// it would be: its body and whether it is pinned.
func checkPinned(ctx context.Context, db *projectstore.DB, id string, pinned bool, bodyChars int) error {
	if !pinned {
		return nil
	}
	all, err := db.Notes(ctx)
	if err != nil {
		return err
	}
	sizes := []int{bodyChars}
	for _, o := range all {
		if o.Pinned && o.ID != id {
			sizes = append(sizes, o.Size)
		}
	}
	if err := notemd.CheckPinned(sizes); err != nil {
		return invalid("%v", err)
	}
	return nil
}

// Create is the legacy two-field create (a description is derived).
func (n *Notes) Create(ctx context.Context, pid, title, content string) (projectstore.Note, error) {
	return n.CreateNote(ctx, pid, NoteInput{Title: title, Content: content})
}

// CreateNote creates a note as the user.
func (n *Notes) CreateNote(ctx context.Context, pid string, in NoteInput) (projectstore.Note, error) {
	f, err := in.resolve()
	if err != nil {
		return projectstore.Note{}, err
	}
	db, err := n.db(ctx, pid)
	if err != nil {
		return projectstore.Note{}, err
	}
	if err := checkPinned(ctx, db, "", f.Pinned, len([]rune(f.Body))); err != nil {
		return projectstore.Note{}, err
	}
	note, err := db.InsertNote(ctx, f, projectstore.AuthorUser)
	if err != nil {
		return note, err
	}
	n.changed(pid, note.ID, &note)
	return note, nil
}

// NotePatch changes some fields of a note; Markdown replaces them all.
type NotePatch struct {
	Title       *string
	Description *string
	Tags        *[]string
	Pinned      *bool
	Content     *string
	Markdown    *string
}

func (n *Notes) Update(ctx context.Context, pid, id string, title, content *string) (projectstore.Note, error) {
	return n.Patch(ctx, pid, id, NotePatch{Title: title, Content: content})
}

// Patch changes a note as the user.
func (n *Notes) Patch(ctx context.Context, pid, id string, p NotePatch) (projectstore.Note, error) {
	db, err := n.db(ctx, pid)
	if err != nil {
		return projectstore.Note{}, err
	}
	cur, err := db.Note(ctx, id)
	if errors.Is(err, projectstore.ErrNotFound) {
		return cur, notFound("note")
	}
	if err != nil {
		return cur, err
	}
	sp := projectstore.NotePatch{Title: p.Title, Description: p.Description, Tags: p.Tags, Pinned: p.Pinned, Body: p.Content}
	if p.Markdown != nil {
		d, err := notemd.Parse(*p.Markdown)
		if err != nil {
			return cur, invalid("markdown: %v", err)
		}
		sp = projectstore.NotePatch{Body: &d.Body}
		if d.HasFrontMatter {
			sp.Title, sp.Description, sp.Tags, sp.Pinned = &d.Title, &d.Description, &d.Tags, &d.Pinned
		}
	}
	if sp.Title != nil {
		t := strings.TrimSpace(*sp.Title)
		if t == "" {
			return cur, invalid("title must not be empty")
		}
		sp.Title = &t
	}
	title, desc, tags := cur.Title, cur.Description, cur.Tags
	if sp.Title != nil {
		title = *sp.Title
	}
	if sp.Description != nil {
		desc = *sp.Description
	}
	if sp.Tags != nil {
		tags = *sp.Tags
	}
	if err := check(title, desc, tags); err != nil {
		return cur, err
	}
	pinned, size := cur.Pinned, cur.Size
	if sp.Pinned != nil {
		pinned = *sp.Pinned
	}
	if sp.Body != nil {
		size = len([]rune(*sp.Body))
	}
	if err := checkPinned(ctx, db, id, pinned, size); err != nil {
		return cur, err
	}
	note, err := db.PatchNote(ctx, id, sp)
	if err != nil {
		return note, err
	}
	n.changed(pid, id, &note)
	return note, nil
}

func (n *Notes) Delete(ctx context.Context, pid, id string) error {
	db, err := n.db(ctx, pid)
	if err != nil {
		return err
	}
	if err := db.DeleteNote(ctx, id); errors.Is(err, projectstore.ErrNotFound) {
		return notFound("note")
	} else if err != nil {
		return err
	}
	n.changed(pid, id, nil)
	return nil
}

// Write creates (no id) or updates (id) a note on behalf of an agent (write_note;
// the description is required). It reports whether the note is new.
func (n *Notes) Write(ctx context.Context, pid, id, title, description, body string, tagList *[]string) (note projectstore.Note, created bool, err error) {
	in := struct {
		ID, Title, Description, Body string
		Tags                         *[]string
	}{id, strings.TrimSpace(title), strings.TrimSpace(description), body, tagList}
	if in.Description == "" {
		return note, false, invalid("description is required: one line (at most %d characters) that tells a reader when this note is worth opening", notemd.MaxDescription)
	}
	var tags []string
	if in.Tags != nil {
		tags = *in.Tags
	}
	if err := check(in.Title, in.Description, tags); err != nil {
		return note, false, err
	}
	db, err := n.db(ctx, pid)
	if err != nil {
		return note, false, err
	}
	if in.ID == "" {
		if same, err := db.NoteByTitle(ctx, in.Title); err == nil {
			return note, false, invalid("a note titled %q exists (%s); pass its id to update it, or choose another title", in.Title, same.ID)
		}
		f := projectstore.NoteFields{Title: in.Title, Description: in.Description, Tags: tags, Body: in.Body}
		note, err = db.InsertNote(ctx, f, projectstore.AuthorOrchestrator)
		created = true
	} else {
		cur, gerr := db.Note(ctx, in.ID)
		if errors.Is(gerr, projectstore.ErrNotFound) {
			return note, false, notFound("note " + in.ID)
		}
		if gerr != nil {
			return note, false, gerr
		}
		if err := checkPinned(ctx, db, cur.ID, cur.Pinned, len([]rune(in.Body))); err != nil {
			return note, false, err
		}
		note, err = db.PatchNote(ctx, in.ID, projectstore.NotePatch{Title: &in.Title, Description: &in.Description, Tags: in.Tags, Body: &in.Body})
	}
	if err != nil {
		return note, created, err
	}
	n.changed(pid, note.ID, &note)
	return note, created, nil
}

// Save upserts a note by title as the orchestrator (orchestrator.NoteBook):
// the description is derived from the body unless the note keeps one written.
func (n *Notes) Save(ctx context.Context, pid, title, content string) (projectstore.Note, error) {
	db, err := n.db(ctx, pid)
	if err != nil {
		return projectstore.Note{}, err
	}
	existing, err := db.NoteByTitle(ctx, title)
	var note projectstore.Note
	switch {
	case err == nil:
		if err := checkPinned(ctx, db, existing.ID, existing.Pinned, len([]rune(content))); err != nil {
			return note, err
		}
		note, err = db.UpdateNote(ctx, existing.ID, nil, &content)
	case errors.Is(err, projectstore.ErrNotFound):
		note, err = db.CreateNote(ctx, title, content, projectstore.AuthorOrchestrator)
	}
	if err != nil {
		return note, err
	}
	n.changed(pid, note.ID, &note)
	return note, nil
}

// DeleteByTitle removes a note by title (orchestrator.NoteBook).
func (n *Notes) DeleteByTitle(ctx context.Context, pid, title string) error {
	db, err := n.db(ctx, pid)
	if err != nil {
		return err
	}
	note, err := db.NoteByTitle(ctx, title)
	if err != nil {
		return err
	}
	if err := db.DeleteNote(ctx, note.ID); err != nil {
		return err
	}
	n.changed(pid, note.ID, nil)
	return nil
}
