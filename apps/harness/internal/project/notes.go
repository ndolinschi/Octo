package project

import (
	"context"
	"errors"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/events"
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

func (n *Notes) changed(pid, id string, note *projectstore.Note) {
	var payload any
	if note != nil {
		payload = *note
	}
	n.hub.Publish(pid, events.NoteChanged, map[string]any{"note": payload, "note_id": id})
	n.hub.Publish(pid, events.ContextUpdated, map[string]any{"project_id": pid}) // the notes are part of the context
}

func (n *Notes) List(ctx context.Context, pid string) ([]projectstore.Note, error) {
	db, err := n.db(ctx, pid)
	if err != nil {
		return nil, err
	}
	return db.Notes(ctx)
}

func (n *Notes) Create(ctx context.Context, pid, title, content string) (projectstore.Note, error) {
	title = strings.TrimSpace(title)
	if title == "" {
		return projectstore.Note{}, invalid("title is required")
	}
	db, err := n.db(ctx, pid)
	if err != nil {
		return projectstore.Note{}, err
	}
	note, err := db.CreateNote(ctx, title, content, projectstore.AuthorUser)
	if err != nil {
		return note, err
	}
	n.changed(pid, note.ID, &note)
	return note, nil
}

func (n *Notes) Update(ctx context.Context, pid, id string, title, content *string) (projectstore.Note, error) {
	if title != nil {
		t := strings.TrimSpace(*title)
		if t == "" {
			return projectstore.Note{}, invalid("title must not be empty")
		}
		title = &t
	}
	db, err := n.db(ctx, pid)
	if err != nil {
		return projectstore.Note{}, err
	}
	note, err := db.UpdateNote(ctx, id, title, content)
	if errors.Is(err, projectstore.ErrNotFound) {
		return note, notFound("note")
	}
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

// Save upserts a note by title as the orchestrator (orchestrator.NoteBook).
func (n *Notes) Save(ctx context.Context, pid, title, content string) (projectstore.Note, error) {
	db, err := n.db(ctx, pid)
	if err != nil {
		return projectstore.Note{}, err
	}
	existing, err := db.NoteByTitle(ctx, title)
	var note projectstore.Note
	switch {
	case err == nil:
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
