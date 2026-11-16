package projectstore

import (
	"context"
	"database/sql"
	"errors"
)

// WorkspaceFolder records one folder mapping inside a workspace.
type WorkspaceFolder struct {
	WorkspaceID string `json:"workspace_id"`
	FolderID    string `json:"folder_id"`
	FolderLabel string `json:"folder_label,omitempty"`
	Path        string `json:"path"`
	RepoRoot    string `json:"repo_root,omitempty"`
	Branch      string `json:"branch,omitempty"`
	BaseBranch  string `json:"base_branch,omitempty"`
	BaseCommit  string `json:"base_commit,omitempty"`
	Shared      bool   `json:"shared"`
}

// Workspace describes a session workspace ("shared" or "worktree").
type Workspace struct {
	ID           string            `json:"id"`
	Kind         string            `json:"kind"`
	Title        string            `json:"title"`
	State        string            `json:"state"`
	Branch       string            `json:"branch,omitempty"`
	BaseBranch   string            `json:"base_branch,omitempty"`
	CarryChanges bool              `json:"carry_changes,omitempty"`
	CreatedAt    string            `json:"created_at"`
	RemovedAt    string            `json:"removed_at,omitempty"`
	Folders      []WorkspaceFolder `json:"folders"`
}

// CreateWorktreeWorkspace persists a new worktree workspace and its folder rows.
func (d *DB) CreateWorktreeWorkspace(ctx context.Context, w Workspace, folders []WorkspaceFolder) (Workspace, error) {
	if w.ID == "" {
		w.ID = NewID("wrk")
	}
	if w.Kind == "" {
		w.Kind = "worktree"
	}
	if w.State == "" {
		w.State = "ready"
	}
	if w.CreatedAt == "" {
		w.CreatedAt = Now()
	}
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return Workspace{}, err
	}
	defer func() { _ = tx.Rollback() }()
	carry := 0
	if w.CarryChanges {
		carry = 1
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO workspaces (id, kind, title, state, carry_changes, created_at, removed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		w.ID, w.Kind, w.Title, w.State, carry, w.CreatedAt, w.RemovedAt,
	); err != nil {
		return Workspace{}, err
	}
	for _, f := range folders {
		shared := 0
		if f.Shared {
			shared = 1
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO workspace_folders (workspace_id, folder_id, path, repo_root, branch, base_branch, base_commit, shared)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			w.ID, f.FolderID, f.Path, f.RepoRoot, f.Branch, f.BaseBranch, f.BaseCommit, shared,
		); err != nil {
			return Workspace{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return Workspace{}, err
	}
	if err := d.Touch(ctx); err != nil {
		return Workspace{}, err
	}
	return d.GetWorkspace(ctx, w.ID)
}

func (d *DB) loadWorkspaceFolders(ctx context.Context, wid string) ([]WorkspaceFolder, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT wf.workspace_id, wf.folder_id, COALESCE(f.label, ''), wf.path, wf.repo_root, wf.branch, wf.base_branch, wf.base_commit, wf.shared
		FROM workspace_folders wf LEFT JOIN folders f ON f.id = wf.folder_id
		WHERE wf.workspace_id = ? ORDER BY wf.rowid`, wid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WorkspaceFolder{}
	for rows.Next() {
		var f WorkspaceFolder
		var shared int
		if err := rows.Scan(&f.WorkspaceID, &f.FolderID, &f.FolderLabel, &f.Path, &f.RepoRoot, &f.Branch, &f.BaseBranch, &f.BaseCommit, &shared); err != nil {
			return nil, err
		}
		f.Shared = shared != 0
		out = append(out, f)
	}
	return out, rows.Err()
}

// GetWorkspace returns one workspace by id (including synthetic "shared" when the row is absent).
func (d *DB) GetWorkspace(ctx context.Context, id string) (Workspace, error) {
	if id == "" {
		id = SharedWorkspace
	}
	var w Workspace
	var carry int
	err := d.sql.QueryRowContext(ctx, `SELECT id, kind, title, state, carry_changes, created_at, removed_at FROM workspaces WHERE id = ?`, id).
		Scan(&w.ID, &w.Kind, &w.Title, &w.State, &carry, &w.CreatedAt, &w.RemovedAt)
	if errors.Is(err, sql.ErrNoRows) {
		if id == SharedWorkspace {
			pInfo, perr := d.Info(ctx)
			created := ""
			if perr == nil {
				created = pInfo.CreatedAt
			}
			pf, ferr := d.Folders(ctx)
			if ferr != nil {
				return Workspace{}, ferr
			}
			wf := make([]WorkspaceFolder, 0, len(pf))
			for _, f := range pf {
				wf = append(wf, WorkspaceFolder{WorkspaceID: SharedWorkspace, FolderID: f.ID, FolderLabel: f.Label, Path: f.Path, Shared: true})
			}
			return Workspace{ID: SharedWorkspace, Kind: "shared", Title: "Main checkout", State: "ready", CreatedAt: created, Folders: wf}, nil
		}
		return Workspace{}, ErrNotFound
	}
	if err != nil {
		return Workspace{}, err
	}
	w.CarryChanges = carry != 0
	if w.Kind == "shared" {
		pf, ferr := d.Folders(ctx)
		if ferr != nil {
			return Workspace{}, ferr
		}
		w.Folders = make([]WorkspaceFolder, 0, len(pf))
		for _, f := range pf {
			w.Folders = append(w.Folders, WorkspaceFolder{WorkspaceID: w.ID, FolderID: f.ID, FolderLabel: f.Label, Path: f.Path, Shared: true})
		}
		return w, nil
	}
	wf, err := d.loadWorkspaceFolders(ctx, w.ID)
	if err != nil {
		return Workspace{}, err
	}
	w.Folders = wf
	for _, f := range wf {
		if w.Branch == "" && f.Branch != "" {
			w.Branch = f.Branch
		}
		if w.BaseBranch == "" && f.BaseBranch != "" {
			w.BaseBranch = f.BaseBranch
		}
	}
	return w, nil
}

// ListWorkspaces lists all active workspaces (always including "shared" first).
func (d *DB) ListWorkspaces(ctx context.Context) ([]Workspace, error) {
	shared, err := d.GetWorkspace(ctx, SharedWorkspace)
	if err != nil {
		return nil, err
	}
	rows, err := d.sql.QueryContext(ctx, `SELECT id, kind, title, state, carry_changes, created_at, removed_at
		FROM workspaces WHERE removed_at = '' AND id != ? ORDER BY created_at DESC, rowid DESC`, SharedWorkspace)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Workspace{shared}
	for rows.Next() {
		var w Workspace
		var carry int
		if err := rows.Scan(&w.ID, &w.Kind, &w.Title, &w.State, &carry, &w.CreatedAt, &w.RemovedAt); err != nil {
			return nil, err
		}
		w.CarryChanges = carry != 0
		wf, err := d.loadWorkspaceFolders(ctx, w.ID)
		if err != nil {
			return nil, err
		}
		w.Folders = wf
		for _, f := range wf {
			if w.Branch == "" && f.Branch != "" {
				w.Branch = f.Branch
			}
			if w.BaseBranch == "" && f.BaseBranch != "" {
				w.BaseBranch = f.BaseBranch
			}
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

// SetSessionWorkspace points a main session at wid.
func (d *DB) SetSessionWorkspace(ctx context.Context, sid, wid string) error {
	if wid == "" {
		wid = SharedWorkspace
	}
	var kind string
	err := d.sql.QueryRowContext(ctx, `SELECT kind FROM sessions WHERE id = ?`, sid).Scan(&kind)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && kind != KindMain) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if _, err := d.sql.ExecContext(ctx, `UPDATE sessions SET workspace_id = ? WHERE id = ?`, wid, sid); err != nil {
		return err
	}
	return d.Touch(ctx)
}

// WorkspaceFolderPath looks up a folder's checkout path inside workspace wid by label or folder id.
func (d *DB) WorkspaceFolderPath(ctx context.Context, wid, folderLabel string) (string, bool, error) {
	if wid == "" || wid == SharedWorkspace {
		return "", false, nil
	}
	var path string
	err := d.sql.QueryRowContext(ctx, `SELECT wf.path FROM workspace_folders wf
		LEFT JOIN folders f ON f.id = wf.folder_id
		WHERE wf.workspace_id = ? AND (f.label = ? OR wf.folder_id = ?) LIMIT 1`, wid, folderLabel, folderLabel).Scan(&path)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return path, path != "", nil
}

// WorkspaceFoldersMap returns folder label -> path for workspace wid.
func (d *DB) WorkspaceFoldersMap(ctx context.Context, wid string) (map[string]string, error) {
	if wid == "" || wid == SharedWorkspace {
		return nil, nil
	}
	rows, err := d.sql.QueryContext(ctx, `SELECT COALESCE(NULLIF(f.label, ''), wf.folder_id), wf.path
		FROM workspace_folders wf LEFT JOIN folders f ON f.id = wf.folder_id
		WHERE wf.workspace_id = ?`, wid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var label, path string
		if err := rows.Scan(&label, &path); err != nil {
			return nil, err
		}
		if label != "" && path != "" {
			out[label] = path
		}
	}
	return out, rows.Err()
}
