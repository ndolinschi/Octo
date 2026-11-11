package orchestrator

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools/local"
)

// ToolReadNotes is the side question's read-only view of the project notes.
const ToolReadNotes = "read_notes"

var readNotesSchema = json.RawMessage(`{"type":"object","properties":{` +
	`"title":{"type":"string","description":"Title of one note; omit to read every note"}},"required":[]}`)

// SideToolNames are the tools a side question gets, in the order registered.
// Every one is read-only; there is no write, shell or spawn tool among them.
var SideToolNames = []string{local.ToolListDir, local.ToolReadFile, local.ToolSearchFiles, ToolReadNotes}

// sideRegistry builds the read-only tool set of a side question.
func (rt *runtime) sideRegistry() (*tools.Registry, error) {
	reg := tools.NewRegistry()
	err := local.RegisterRootsLimits(reg, rt.roots(), rt.o.opts.Limits,
		local.ToolListDir, local.ToolReadFile, local.ToolSearchFiles)
	if err != nil {
		return nil, err
	}
	err = reg.Register(tools.Def{
		Name:        ToolReadNotes,
		Description: "Read the project's notes (durable memory), one by title or all of them. Read-only.",
		InputSchema: readNotesSchema,
		Handle: func(ctx context.Context, input json.RawMessage) (string, bool, error) {
			var in struct{ Title string }
			if len(input) > 0 {
				if err := json.Unmarshal(input, &in); err != nil {
					return err.Error(), true, nil
				}
			}
			notes, err := rt.db.Notes(ctx)
			if err != nil {
				return "", false, err
			}
			var b strings.Builder
			for _, n := range notes {
				if in.Title == "" || strings.EqualFold(n.Title, strings.TrimSpace(in.Title)) {
					fmt.Fprintf(&b, "### %s\n%s\n", n.Title, n.Content)
				}
			}
			if b.Len() == 0 {
				return "no matching notes", false, nil
			}
			return b.String(), false, nil
		},
	})
	return reg, err
}
