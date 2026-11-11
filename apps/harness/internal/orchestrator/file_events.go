package orchestrator

import (
	"context"
	"encoding/json"
	"path/filepath"

	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools/local"
)

// announceWrites publishes file.changed after each successful write_file call.
func (rt *runtime) announceWrites(reg *tools.Registry) {
	if len(rt.folders) == 0 {
		return
	}
	reg.Decorate(local.ToolWriteFile, func(next tools.Handler) tools.Handler {
		return func(ctx context.Context, input json.RawMessage) (string, bool, error) {
			out, isErr, err := next(ctx, input)
			if err != nil || isErr {
				return out, isErr, err
			}
			var in struct{ Folder, Path string }
			if json.Unmarshal(input, &in) == nil {
				if in.Folder == "" {
					in.Folder = rt.folders[0].Label
				}
				rt.publish(events.FileChanged, map[string]any{
					"folder": in.Folder, "path": filepath.ToSlash(filepath.Clean(in.Path)), "source": events.SourceAgent,
				})
			}
			return out, isErr, err
		}
	})
}
