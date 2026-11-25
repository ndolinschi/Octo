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
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
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
	return f.rootForWorkspace(ctx, pid, folder, "")
}

func (f *Files) rootForWorkspace(ctx context.Context, pid, folder, workspaceID string) (root string, review bool, err error) {
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
	if workspaceID != "" && workspaceID != projectstore.SharedWorkspace {
		p, ok, err := db.WorkspaceFolderPath(ctx, workspaceID, folder)
		if err != nil {
			return "", false, storeErr(err)
		}
		if ok {
			return p, false, nil
		}
		if _, err := db.GetWorkspace(ctx, workspaceID); errors.Is(err, projectstore.ErrNotFound) {
			return "", false, notFound("workspace")
		} else if err != nil {
			return "", false, storeErr(err)
		}
		return "", false, notFound("folder")
	}
	folders, err := db.Folders(ctx)
	if err != nil {
		return "", false, err
	}
	for _, fo := range folders {
		if fo.Label == folder {
			if u := fo.Missing(); u != nil {
				return "", false, folderMissing(u)
			}
			return fo.Path, false, nil
		}
	}
	return "", false, notFound("folder")
}

func (f *Files) List(ctx context.Context, pid, folder, path string) ([]files.Entry, error) {
	return f.ListInWorkspace(ctx, pid, folder, path, "")
}

func (f *Files) ListInWorkspace(ctx context.Context, pid, folder, path, workspaceID string) ([]files.Entry, error) {
	root, _, err := f.rootForWorkspace(ctx, pid, folder, workspaceID)
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
	return f.ReadInWorkspace(ctx, pid, folder, path, "")
}

func (f *Files) ReadInWorkspace(ctx context.Context, pid, folder, path, workspaceID string) (FileContent, error) {
	root, _, err := f.rootForWorkspace(ctx, pid, folder, workspaceID)
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
	return f.ReadBytesInWorkspace(ctx, pid, folder, path, "")
}

func (f *Files) ReadBytesInWorkspace(ctx context.Context, pid, folder, path, workspaceID string) (FileBytes, error) {
	root, _, err := f.rootForWorkspace(ctx, pid, folder, workspaceID)
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
	return f.WriteInWorkspace(ctx, pid, folder, path, content, expectedMTime, "")
}

// WriteInWorkspace saves content in the given workspace ("": main checkout).
func (f *Files) WriteInWorkspace(ctx context.Context, pid, folder, path, content string, expectedMTime *string, workspaceID string) (FileStat, error) {
	var expected *time.Time
	if expectedMTime != nil {
		t, err := time.Parse(time.RFC3339Nano, *expectedMTime)
		if err != nil {
			return FileStat{}, invalid("expected_mtime must be an RFC 3339 timestamp")
		}
		expected = &t
	}
	root, review, err := f.rootForWorkspace(ctx, pid, folder, workspaceID)
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
	fields := map[string]any{"folder": folder, "path": info.Path, "source": events.SourceUser}
	if workspaceID != "" && workspaceID != projectstore.SharedWorkspace {
		fields["workspace_id"] = workspaceID
	}
	f.hub.Publish(pid, events.FileChanged, fields)
	if instructions.IsInstructionFile(info.Path) {
		f.hub.Publish(pid, events.ContextUpdated, map[string]any{"project_id": pid})
	}
	return stat(folder, info), nil
}

// FileSearchMatch is a filename or content match tagged with its project folder label.
type FileSearchMatch struct {
	Folder  string `json:"folder"`
	Path    string `json:"path"`
	Line    int    `json:"line,omitempty"`
	Column  int    `json:"column,omitempty"`
	Preview string `json:"preview,omitempty"`
}

// SearchInWorkspace searches files across all folders of pid (or one workspace) by name or content.
func (f *Files) SearchInWorkspace(ctx context.Context, pid, query, mode, workspaceID string, limit int) ([]FileSearchMatch, error) {
	db, err := f.store.Get(ctx, pid)
	if errors.Is(err, projectstore.ErrNotFound) {
		return nil, notFound("project")
	}
	if err != nil {
		return nil, storeErr(err)
	}
	folders, err := db.Folders(ctx)
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	out := make([]FileSearchMatch, 0, limit)
	for _, fo := range folders {
		if len(out) >= limit {
			break
		}
		root := fo.Path
		if workspaceID != "" && workspaceID != projectstore.SharedWorkspace {
			if p, ok, err := db.WorkspaceFolderPath(ctx, workspaceID, fo.Label); err == nil && ok {
				root = p
			}
		}
		if fi, err := os.Stat(root); err != nil || !fi.IsDir() {
			continue
		}
		hits, err := files.Search(root, query, mode, limit-len(out))
		if err != nil {
			return nil, fileErr(err)
		}
		for _, h := range hits {
			out = append(out, FileSearchMatch{
				Folder:  fo.Label,
				Path:    h.Path,
				Line:    h.Line,
				Column:  h.Column,
				Preview: h.Preview,
			})
			if len(out) >= limit {
				break
			}
		}
	}
	return out, nil
}

// MkdirInWorkspace creates a directory inside a project folder.
func (f *Files) MkdirInWorkspace(ctx context.Context, pid, folder, path, workspaceID string) (string, error) {
	root, review, err := f.rootForWorkspace(ctx, pid, folder, workspaceID)
	if err != nil {
		return "", err
	}
	if review {
		return "", reviewReadOnly()
	}
	clean, err := files.Mkdir(root, path)
	if err != nil {
		return "", fileErr(err)
	}
	f.publishFileChanged(pid, folder, clean, workspaceID)
	return clean, nil
}

// RenameInWorkspace renames a file or directory inside a project folder.
func (f *Files) RenameInWorkspace(ctx context.Context, pid, folder, from, to, workspaceID string) (string, error) {
	root, review, err := f.rootForWorkspace(ctx, pid, folder, workspaceID)
	if err != nil {
		return "", err
	}
	if review {
		return "", reviewReadOnly()
	}
	clean, err := files.Rename(root, from, to)
	if err != nil {
		return "", fileErr(err)
	}
	f.publishFileChanged(pid, folder, clean, workspaceID)
	return clean, nil
}

// DeleteInWorkspace deletes a file or directory inside a project folder.
func (f *Files) DeleteInWorkspace(ctx context.Context, pid, folder, path, workspaceID string) error {
	root, review, err := f.rootForWorkspace(ctx, pid, folder, workspaceID)
	if err != nil {
		return err
	}
	if review {
		return reviewReadOnly()
	}
	clean, err := files.Delete(root, path)
	if err != nil {
		return fileErr(err)
	}
	f.publishFileChanged(pid, folder, clean, workspaceID)
	return nil
}

func (f *Files) publishFileChanged(pid, folder, rel, workspaceID string) {
	fields := map[string]any{"folder": folder, "path": rel, "source": events.SourceUser}
	if workspaceID != "" && workspaceID != projectstore.SharedWorkspace {
		fields["workspace_id"] = workspaceID
	}
	f.hub.Publish(pid, events.FileChanged, fields)
}

func stat(folder string, info files.Info) FileStat {
	return FileStat{Folder: folder, Path: info.Path, Size: info.Size, MTime: files.FormatTime(info.MTime)}
}

func fileErr(err error) error {
	switch {
	case errors.Is(err, files.ErrNotFound):
		return notFound("path")
	case errors.Is(err, files.ErrExists):
		return of(KindConflict, usererr.PathAlreadyExists())
	case errors.Is(err, files.ErrGitPath):
		return of(KindInvalid, usererr.GitPathRefused(err.Error()))
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
