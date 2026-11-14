package projectstore

import (
	"context"
	"encoding/json"
	"fmt"
)

// SettingSessions is the project_settings key of the sessions settings (schema 15).
const SettingSessions = "sessions"

// Sessions settings: the default and the range of max_running, the workspace of a new session, coordination.
const (
	DefaultMaxRunning = 3
	MaxRunningLimit   = 8

	WorkspaceShared   = "shared"
	WorkspaceWorktree = "worktree"

	CoordinationWorkspace = "workspace"
	CoordinationProject   = "project"
	CoordinationOff       = "off"
)

// SessionsSettings is the project's sessions setting: how many of its main sessions run turns at once, where a
// new session works and how sessions coordinate (the last two are read by later phases).
type SessionsSettings struct {
	MaxRunning       int    `json:"max_running"`
	DefaultWorkspace string `json:"default_workspace"`
	Coordination     string `json:"coordination"`
}

// DefaultSessionsSettings is what a project without the setting has.
func DefaultSessionsSettings() SessionsSettings {
	return SessionsSettings{MaxRunning: DefaultMaxRunning, DefaultWorkspace: WorkspaceShared, Coordination: CoordinationWorkspace}
}

// Merge overlays the set fields of o (a patch: zero values are not set).
func (s SessionsSettings) Merge(o SessionsSettings) SessionsSettings {
	if o.MaxRunning != 0 {
		s.MaxRunning = o.MaxRunning
	}
	if o.DefaultWorkspace != "" {
		s.DefaultWorkspace = o.DefaultWorkspace
	}
	if o.Coordination != "" {
		s.Coordination = o.Coordination
	}
	return s
}

// Validate checks the set fields of a patch.
func (s SessionsSettings) Validate() error {
	if s.MaxRunning != 0 && (s.MaxRunning < 1 || s.MaxRunning > MaxRunningLimit) {
		return fmt.Errorf("session_settings.max_running must be from 1 to %d", MaxRunningLimit)
	}
	switch s.DefaultWorkspace {
	case "", WorkspaceShared, WorkspaceWorktree:
	default:
		return fmt.Errorf("session_settings.default_workspace must be shared or worktree")
	}
	switch s.Coordination {
	case "", CoordinationWorkspace, CoordinationProject, CoordinationOff:
	default:
		return fmt.Errorf("session_settings.coordination must be workspace, project or off")
	}
	return nil
}

// SessionsSettings reads the project's sessions setting (the defaults for what it does not say).
func (d *DB) SessionsSettings(ctx context.Context) SessionsSettings {
	out := DefaultSessionsSettings()
	raw, ok, err := d.Setting(ctx, SettingSessions)
	if err != nil || !ok {
		return out
	}
	var s SessionsSettings
	if json.Unmarshal([]byte(raw), &s) != nil || s.Validate() != nil {
		return out
	}
	return out.Merge(s)
}

// SetSessionsSettings stores the project's sessions setting.
func (d *DB) SetSessionsSettings(ctx context.Context, s SessionsSettings) error {
	b, err := json.Marshal(s)
	if err != nil {
		return err
	}
	return d.SetSetting(ctx, SettingSessions, string(b))
}
