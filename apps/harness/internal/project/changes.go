package project

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/changes"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/files"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools/local"
)

// ChangeRetention is how long a change keeps its diff (its blobs).
const ChangeRetention = 30 * 24 * time.Hour

// Changes lists what agents changed, one entry per file per turn, newest turn
// first; turn > 0 narrows to one turn.
func (s *Service) Changes(ctx context.Context, pid string, turn int64) ([]changes.TurnChanges, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return nil, err
	}
	list, err := db.Changes(ctx, turn)
	if err != nil {
		return nil, err
	}
	return changes.Summarize(ctx, db, list)
}

// Change returns one change with the content before and after.
func (s *Service) Change(ctx context.Context, pid string, id int64) (changes.Detail, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return changes.Detail{}, err
	}
	c, err := db.Change(ctx, id)
	if errors.Is(err, projectstore.ErrNotFound) {
		return changes.Detail{}, notFound("change")
	}
	if err != nil {
		return changes.Detail{}, err
	}
	return changes.DetailOf(ctx, db, c)
}

// RevertResult is the file after a revert; Deleted is set when the revert
// removed a created file.
type RevertResult struct {
	FileStat
	Deleted bool `json:"deleted,omitempty"`
}

// RevertChange writes the content before a change back (deleting a file the
// change created). It is refused with file_changed when the file no longer is
// what the change left, and with revert_unavailable when the earlier content
// was not kept.
func (s *Service) RevertChange(ctx context.Context, pid string, id int64) (RevertResult, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return RevertResult{}, err
	}
	c, err := db.Change(ctx, id)
	if errors.Is(err, projectstore.ErrNotFound) {
		return RevertResult{}, notFound("change")
	}
	if err != nil {
		return RevertResult{}, err
	}
	folders, err := db.Folders(ctx)
	if err != nil {
		return RevertResult{}, err
	}
	root := ""
	for _, f := range folders {
		if f.Label == c.Folder {
			root = f.Path
		}
	}
	if root == "" {
		return RevertResult{}, notFound("folder")
	}
	abs, err := local.Resolve(root, c.Path)
	if err != nil {
		return RevertResult{}, invalid("path %q is outside the project folder", c.Path)
	}
	hash, exists, err := changes.HashFile(abs)
	if err != nil {
		return RevertResult{}, err
	}
	if c.Kind == projectstore.ChangeDeleted {
		if exists {
			return RevertResult{}, fileChanged()
		}
	} else if !exists || c.AfterHash == nil || hash != *c.AfterHash {
		return RevertResult{}, fileChanged()
	}
	if c.Kind == projectstore.ChangeCreated {
		if err := os.Remove(abs); err != nil {
			return RevertResult{}, err
		}
		s.recordRevert(ctx, db, pid, c)
		s.hub.Publish(pid, events.FileChanged, map[string]any{"folder": c.Folder, "path": c.Path, "source": events.SourceUser})
		return RevertResult{FileStat: FileStat{Folder: c.Folder, Path: c.Path, MTime: files.FormatTime(time.Now())}, Deleted: true}, nil
	}
	if c.BeforeHash == nil {
		return RevertResult{}, revertUnavailable(c.Note)
	}
	before, ok, err := db.Blob(ctx, *c.BeforeHash)
	if err != nil {
		return RevertResult{}, err
	}
	if !ok {
		return RevertResult{}, revertUnavailable(c.Note)
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return RevertResult{}, err
	}
	info, err := files.Write(root, c.Path, before, nil)
	if err != nil {
		return RevertResult{}, fileErr(err)
	}
	s.recordRevert(ctx, db, pid, c)
	s.hub.Publish(pid, events.FileChanged, map[string]any{"folder": c.Folder, "path": info.Path, "source": events.SourceUser})
	return RevertResult{FileStat: stat(c.Folder, info)}, nil
}

// recordRevert stores a revert as the inverse of change c in c's turn (c's after back to its before) and announces it
// with change.recorded. Summarize then nets the file out of GET /changes once it is back to what it was before the
// turn, the way it does for a file an agent created and deleted again; a partial revert leaves the rest listed. It
// keeps c's agent, source and session, so the row keeps its attribution and session filter and no new source value
// reaches clients; tool_use_id "revert:<id>" marks it. The file is already reverted on disk, so a failure to record
// is logged and the revert still succeeds.
func (s *Service) recordRevert(ctx context.Context, db *projectstore.DB, pid string, c projectstore.Change) {
	inv := projectstore.Change{
		TurnID: c.TurnID, AgentID: c.AgentID, SessionID: c.SessionID, WorkspaceID: c.WorkspaceID,
		Folder: c.Folder, Path: c.Path, Kind: projectstore.ChangeModified, BeforeHash: c.AfterHash, AfterHash: c.BeforeHash,
		Added: c.Removed, Removed: c.Added, Note: c.Note, Source: c.Source, ToolUseID: "revert:" + strconv.FormatInt(c.ID, 10),
	}
	switch c.Kind {
	case projectstore.ChangeCreated:
		inv.Kind, inv.AfterHash = projectstore.ChangeDeleted, nil
	case projectstore.ChangeDeleted:
		inv.Kind, inv.BeforeHash = projectstore.ChangeCreated, nil
	}
	rec, err := db.AddChange(ctx, projectstore.NewChange{Change: inv})
	if err != nil {
		slog.Error("record revert", "project", pid, "change", c.ID, "err", err)
		return
	}
	s.hub.Publish(pid, events.ChangeRecorded, map[string]any{"turn_id": rec.TurnID, "change": changes.ToFileChange(rec)})
}
