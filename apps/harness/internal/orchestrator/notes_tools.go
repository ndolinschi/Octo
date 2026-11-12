package orchestrator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/notemd"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
)

const (
	ToolSaveNote    = "save_note"
	ToolDeleteNote  = "delete_note"
	ToolReadNote    = "read_note"
	ToolSearchNotes = "search_notes"
	ToolWriteNote   = "write_note"
)

// DefaultNoteHits and MaxNoteHits bound search_notes.
const (
	DefaultNoteHits = 5
	MaxNoteHits     = 10
)

var saveNoteSchema = json.RawMessage(`{"type":"object","properties":{` +
	`"title":{"type":"string","description":"Note title; an existing note with this title is replaced"},` +
	`"content":{"type":"string","description":"Short note body"}},"required":["title","content"]}`)

var deleteNoteSchema = json.RawMessage(`{"type":"object","properties":{` +
	`"title":{"type":"string","description":"Title of the note to delete"}},"required":["title"]}`)

var readNoteSchema = json.RawMessage(`{"type":"object","properties":{` +
	`"id":{"type":"string","description":"Note id from the notes index or a search_notes hit"}},"required":["id"]}`)

var searchNotesSchema = json.RawMessage(`{"type":"object","properties":{` +
	`"query":{"type":"string","description":"Words to find in note titles, descriptions and bodies"},` +
	`"limit":{"type":"integer","description":"Hits to return (default 5, at most 10)"}},"required":["query"]}`)

var writeNoteSchema = json.RawMessage(`{"type":"object","properties":{` +
	`"id":{"type":"string","description":"Id of the note to update; omit to create a new note"},` +
	`"title":{"type":"string","description":"Short title"},` +
	`"description":{"type":"string","description":"One line, at most 200 characters: what the note holds and when it is worth opening. Readers see only this line until they open the note"},` +
	`"body":{"type":"string","description":"The note itself, in Markdown"},` +
	`"tags":{"type":"array","items":{"type":"string"},"description":"Optional tags"}},` +
	`"required":["title","description","body"]}`)

// toolFacing reports an error whose message is for the caller of a tool (a bad
// argument, a missing note): it becomes the tool's error result.
func toolFacing(err error) (string, bool) {
	var tf interface{ ToolFacing() bool }
	if errors.As(err, &tf) && tf.ToolFacing() {
		return err.Error(), true
	}
	return "", false
}

// noteReadDefs are the tools that look notes up; they are read-only.
func (rt *runtime) noteReadDefs() []tools.Def {
	return []tools.Def{
		{
			Name: ToolReadNote,
			Description: "Open one project note and return its body (Markdown). The notes index shows only titles and descriptions; " +
				"open a note when its description says it is relevant.",
			InputSchema: readNoteSchema,
			Handle: func(ctx context.Context, input json.RawMessage) (string, bool, error) {
				var in struct{ ID string }
				if err := json.Unmarshal(input, &in); err != nil {
					return err.Error(), true, nil
				}
				id := strings.TrimSpace(in.ID)
				if id == "" {
					return "id required", true, nil
				}
				note, err := rt.o.notes.Read(ctx, rt.pid(), id)
				if err != nil {
					if msg, ok := toolFacing(err); ok {
						return msg + " (ids are in the notes index and in search_notes hits)", true, nil
					}
					return "", false, err
				}
				if strings.TrimSpace(note.Content) == "" {
					return "(this note has no body; its description is: " + note.Description + ")", false, nil
				}
				return note.Content, false, nil
			},
		},
		{
			Name: ToolSearchNotes,
			Description: "Search project notes by words in their title, description and body (Russian word forms match too). " +
				"Returns hits with id, title, description and a snippet; open one with read_note.",
			InputSchema: searchNotesSchema,
			Handle: func(ctx context.Context, input json.RawMessage) (string, bool, error) {
				var in struct {
					Query string
					Limit int
				}
				if err := json.Unmarshal(input, &in); err != nil {
					return err.Error(), true, nil
				}
				limit := in.Limit
				if limit <= 0 {
					limit = DefaultNoteHits
				}
				limit = min(limit, MaxNoteHits)
				hits, err := rt.o.notes.Search(ctx, rt.pid(), rt.redact(in.Query), limit)
				if err != nil {
					if msg, ok := toolFacing(err); ok {
						return msg, true, nil
					}
					return "", false, err
				}
				type hit struct {
					ID          string   `json:"id"`
					Title       string   `json:"title"`
					Description string   `json:"description"`
					Tags        []string `json:"tags,omitempty"`
					Snippet     string   `json:"snippet"`
				}
				out := struct {
					Hits    []hit  `json:"hits"`
					Message string `json:"message,omitempty"`
				}{Hits: []hit{}}
				for _, h := range hits {
					out.Hits = append(out.Hits, hit{h.ID, h.Title, h.Description, h.Tags, h.Snippet})
				}
				if len(out.Hits) == 0 {
					out.Message = "No note matches. Say so; do not guess what a note might say."
				}
				raw, _ := json.Marshal(out)
				return string(raw), false, nil
			},
		},
	}
}

// noteWriteDefs are the tools that change notes; a read-only mode refuses them.
func (rt *runtime) noteWriteDefs() []tools.Def {
	return []tools.Def{
		{
			Name: ToolWriteNote,
			Description: "Create or update a project note (Markdown). A description is required: one line of at most 200 characters " +
				"saying what the note holds and when to open it; the notes index shows only title and description. " +
				"Pass id to update a note; omit it to create one. Keep notes short and about one subject.",
			InputSchema: writeNoteSchema,
			Handle: func(ctx context.Context, input json.RawMessage) (string, bool, error) {
				var in struct {
					ID, Title, Description, Body string
					Tags                         *[]string
				}
				if err := json.Unmarshal(input, &in); err != nil {
					return err.Error(), true, nil
				}
				note, created, err := rt.o.notes.Write(ctx, rt.pid(), strings.TrimSpace(in.ID), in.Title, in.Description, in.Body, in.Tags)
				if err != nil {
					if msg, ok := toolFacing(err); ok {
						return msg, true, nil
					}
					return "", false, err
				}
				verb := "updated"
				if created {
					verb = "created"
				}
				return fmt.Sprintf("%s note %s (%s)", verb, note.ID, note.Title), false, nil
			},
		},
	}
}

func (rt *runtime) noteDefs() []tools.Def {
	return append(append(rt.noteReadDefs(), rt.noteWriteDefs()...), []tools.Def{
		{
			Name: ToolSaveNote,
			Description: "Quick note: upsert a project note by title with a short body; its description is the body's first line. " +
				"Prefer write_note, which takes a description you write.",
			InputSchema: saveNoteSchema,
			Handle: func(ctx context.Context, input json.RawMessage) (string, bool, error) {
				var in struct{ Title, Content string }
				if err := json.Unmarshal(input, &in); err != nil {
					return err.Error(), true, nil
				}
				if strings.TrimSpace(in.Title) == "" {
					return "title required", true, nil
				}
				note, err := rt.o.notes.Save(ctx, rt.pid(), strings.TrimSpace(in.Title), in.Content)
				if err != nil {
					if msg, ok := toolFacing(err); ok {
						return msg, true, nil
					}
					return "", false, err
				}
				return "saved note " + note.Title, false, nil
			},
		},
		{
			Name:        ToolDeleteNote,
			Description: "Delete a project note by title",
			InputSchema: deleteNoteSchema,
			Handle: func(ctx context.Context, input json.RawMessage) (string, bool, error) {
				var in struct{ Title string }
				if err := json.Unmarshal(input, &in); err != nil {
					return err.Error(), true, nil
				}
				err := rt.o.notes.DeleteByTitle(ctx, rt.pid(), strings.TrimSpace(in.Title))
				if errors.Is(err, projectstore.ErrNotFound) {
					return "no note with that title", true, nil
				}
				if err != nil {
					return "", false, err
				}
				return "deleted note", false, nil
			},
		},
	}...)
}

// noteEntries are the notes as the index takes them.
func noteEntries(notes []projectstore.Note) []notemd.Entry {
	out := make([]notemd.Entry, len(notes))
	for i, n := range notes {
		out[i] = notemd.Entry{ID: n.ID, Title: n.Title, Description: n.Description, Tags: n.Tags, Pinned: n.Pinned,
			UpdatedAt: n.UpdatedAt, LastReadAt: n.LastReadAt}
	}
	return out
}
