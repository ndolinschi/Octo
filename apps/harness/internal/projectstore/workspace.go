package projectstore

import (
	"context"
	"encoding/json"
)

// ReviewWorkspace is the review whose worktree the project's file tree, editor,
// search and language server are currently pointed at ("Open in workspace").
// At most one is active; it is the project's own state, shown in the project.
type ReviewWorkspace struct {
	ReviewID string `json:"review_id"`
	// Path is the absolute path of the review's worktree.
	Path  string `json:"path"`
	Title string `json:"title"`
}

// ReviewWorkspace returns the active review workspace, nil when there is none.
func (d *DB) ReviewWorkspace(ctx context.Context) (*ReviewWorkspace, error) {
	raw, ok, err := d.Setting(ctx, SettingReviewWorkspace)
	if err != nil || !ok {
		return nil, err
	}
	var w ReviewWorkspace
	if json.Unmarshal([]byte(raw), &w) != nil || w.Path == "" {
		return nil, nil
	}
	return &w, nil
}

// SetReviewWorkspace makes w the active review workspace.
func (d *DB) SetReviewWorkspace(ctx context.Context, w ReviewWorkspace) error {
	b, err := json.Marshal(w)
	if err != nil {
		return err
	}
	return d.SetSetting(ctx, SettingReviewWorkspace, string(b))
}

// ClearReviewWorkspace deactivates the review workspace.
func (d *DB) ClearReviewWorkspace(ctx context.Context) error {
	return d.DeleteSetting(ctx, SettingReviewWorkspace)
}
