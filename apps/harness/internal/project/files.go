package project

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/files"
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

func (f *Files) root(ctx context.Context, pid, folder string) (string, error) {
	db, err := f.store.Get(ctx, pid)
	if errors.Is(err, projectstore.ErrNotFound) {
		return "", notFound("project")
	}
	if err != nil {
		return "", storeErr(err)
	}
	folders, err := db.Folders(ctx)
	if err != nil {
		return "", err
	}
	for _, fo := range folders {
		if fo.Label == folder {
			return fo.Path, nil
		}
	}
	return "", notFound("folder")
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
	root, err := f.root(ctx, pid, folder)
	if err != nil {
		return FileStat{}, err
	}
	info, err := files.Write(root, path, content, expected)
	if err != nil {
		return FileStat{}, fileErr(err)
	}
	f.hub.Publish(pid, events.FileChanged, map[string]any{"folder": folder, "path": info.Path, "source": events.SourceUser})
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
