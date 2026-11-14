package project

import (
	"context"
	"encoding/base64"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/files"
	"github.com/ndolinschi/Octo/apps/harness/internal/instructions"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

type FileStat struct {
	Folder string `json:"folder"`
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	MTime  string `json:"mtime"`
}

type FileContent struct {
	FileStat
	Content string `json:"content"`
}

// Files serves a project's folders to the code pane and announces user edits.
type Files struct {
	store *projectstore.Store
	hub   *events.Hub
}

func NewFiles(store *projectstore.Store, hub *events.Hub) *Files {
	return &Files{store: store, hub: hub}
}

// ReviewFolder is the reserved folder label that names the active review
// workspace (the worktree of the review opened "in workspace"). It resolves
// only while a workspace is active; the worktree's absolute path is accepted
// as a folder under the same condition. It is read-only: a review's worktree is
// moved by refreshing the review, which would discard edits.
const ReviewFolder = "@review"

func (f *Files) root(ctx context.Context, pid, folder string) (string, error) {
	root, _, err := f.rootFor(ctx, pid, folder)
	return root, err
}

// rootFor resolves a folder label; review is true for the review workspace.
func (f *Files) rootFor(ctx context.Context, pid, folder string) (root string, review bool, err error) {
	db, err := f.store.Get(ctx, pid)
	if errors.Is(err, projectstore.ErrNotFound) {
		return "", false, notFound("project")
	}
	if err != nil {
		return "", false, storeErr(err)
	}
	if folder == ReviewFolder || filepath.IsAbs(folder) {
		ws, err := db.ReviewWorkspace(ctx)
		if err != nil {
			return "", false, err
		}
		if ws != nil && (folder == ReviewFolder || filepath.Clean(folder) == filepath.Clean(ws.Path)) {
			if fi, err := os.Stat(ws.Path); err == nil && fi.IsDir() {
				return ws.Path, true, nil
			}
		}
		return "", false, notFound("folder")
	}
	folders, err := db.Folders(ctx)
	if err != nil {
		return "", false, err
	}
	for _, fo := range folders {
		if fo.Label == folder {
			return fo.Path, false, nil
		}
	}
	return "", false, notFound("folder")
}

func (f *Files) List(ctx context.Context, pid, folder, path string) ([]files.Entry, error) {
	root, err := f.root(ctx, pid, folder)
	if err != nil {
		return nil, err
	}
	entries, err := files.List(root, path)
	if err != nil {
		return nil, fileErr(err)
	}
	return entries, nil
}

func (f *Files) Read(ctx context.Context, pid, folder, path string) (FileContent, error) {
	root, err := f.root(ctx, pid, folder)
	if err != nil {
		return FileContent{}, err
	}
	text, info, err := files.Read(root, path)
	if err != nil {
		return FileContent{}, fileErr(err)
	}
	return FileContent{FileStat: stat(folder, info), Content: text}, nil
}

// FileBytes is a file's content as base64, for files that are not text
// (image previews); Encoding is always "base64".
type FileBytes struct {
	FileStat
	Content  string `json:"content"`
	Encoding string `json:"encoding"`
}

// ReadBytes is Read for any file: same roots, path checks and size limit, no
// UTF-8 check, content base64-encoded.
func (f *Files) ReadBytes(ctx context.Context, pid, folder, path string) (FileBytes, error) {
	root, err := f.root(ctx, pid, folder)
	if err != nil {
		return FileBytes{}, err
	}
	data, info, err := files.ReadBytes(root, path)
	if err != nil {
		return FileBytes{}, fileErr(err)
	}
	return FileBytes{FileStat: stat(folder, info), Content: base64.StdEncoding.EncodeToString(data), Encoding: "base64"}, nil
}

// Write saves content; expectedMTime, when set, guards against lost updates.
func (f *Files) Write(ctx context.Context, pid, folder, path, content string, expectedMTime *string) (FileStat, error) {
	var expected *time.Time
	if expectedMTime != nil {
		t, err := time.Parse(time.RFC3339Nano, *expectedMTime)
		if err != nil {
			return FileStat{}, invalid("expected_mtime must be an RFC 3339 timestamp")
		}
		expected = &t
	}
	root, review, err := f.rootFor(ctx, pid, folder)
	if err != nil {
		return FileStat{}, err
	}
	if review {
		return FileStat{}, reviewReadOnly()
	}
	info, err := files.Write(root, path, content, expected)
	if err != nil {
		return FileStat{}, fileErr(err)
	}
	f.hub.Publish(pid, events.FileChanged, map[string]any{"folder": folder, "path": info.Path, "source": events.SourceUser})
	if instructions.IsInstructionFile(info.Path) {
		f.hub.Publish(pid, events.ContextUpdated, map[string]any{"project_id": pid})
	}
	return stat(folder, info), nil
}

func stat(folder string, info files.Info) FileStat {
	return FileStat{Folder: folder, Path: info.Path, Size: info.Size, MTime: files.FormatTime(info.MTime)}
}

func fileErr(err error) error {
	switch {
	case errors.Is(err, files.ErrNotFound):
		return notFound("path")
	case errors.Is(err, files.ErrInvalidPath):
		return invalid("%s", err.Error())
	case errors.Is(err, files.ErrNotFile):
		return invalid("path is not a regular file")
	case errors.Is(err, files.ErrTooLarge):
		return fileTooLarge("file exceeds the 2 MiB limit")
	case errors.Is(err, files.ErrBinary):
		return binaryFile()
	case errors.Is(err, files.ErrChanged):
		return fileChanged()
	}
	slog.Error("file operation failed", "err", err)
	return err
}
