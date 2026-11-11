package orchestrator

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
)

const (
	ToolSaveNote   = "save_note"
	ToolDeleteNote = "delete_note"
)

var saveNoteSchema = json.RawMessage(`{"type":"object","properties":{` +
	`"title":{"type":"string","description":"Note title; an existing note with this title is replaced"},` +
	`"content":{"type":"string","description":"Short note body"}},"required":["title","content"]}`)

var deleteNoteSchema = json.RawMessage(`{"type":"object","properties":{` +
	`"title":{"type":"string","description":"Title of the note to delete"}},"required":["title"]}`)

func (rt *runtime) noteDefs() []tools.Def {
	return []tools.Def{
		{
			Name:        ToolSaveNote,
			Description: "Save a durable project note (intent, decision or fact); upserts by title. Notes are shown to you every turn.",
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
	}
}
