package project

import (
	"context"
	"encoding/json"

	"github.com/ndolinschi/Octo/apps/harness/internal/projcfg"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// The project's commands (decision 68) live in the project's settings table, not
// in the project row. They are replaced as a whole by a create or patch that
// carries `commands`.

func loadCommands(ctx context.Context, db *projectstore.DB) []projcfg.Command {
	raw, ok, err := db.Setting(ctx, projectstore.SettingCommands)
	if err != nil || !ok {
		return []projcfg.Command{}
	}
	return projcfg.ParseCommands(raw)
}

// checkCommands validates a commands field (nil: not provided).
func checkCommands(in *[]projcfg.Command) error {
	if in == nil {
		return nil
	}
	if err := projcfg.ValidateCommands(*in); err != nil {
		return invalid("%s", err.Error())
	}
	return nil
}

func loadReviewConfig(ctx context.Context, db *projectstore.DB) projcfg.ReviewConfig {
	raw, ok, err := db.Setting(ctx, projectstore.SettingReviewConfig)
	if err != nil || !ok {
		return projcfg.DefaultReview()
	}
	return projcfg.ParseReview(raw)
}

// checkReview validates a review field (nil: not provided).
func checkReview(in *projcfg.ReviewConfig) error {
	if in == nil {
		return nil
	}
	if err := projcfg.ValidateReview(in); err != nil {
		return invalid("%s", err.Error())
	}
	return nil
}

func saveReview(ctx context.Context, db *projectstore.DB, in *projcfg.ReviewConfig) error {
	if in == nil {
		return nil
	}
	b, err := json.Marshal(*in)
	if err != nil {
		return err
	}
	return db.SetSetting(ctx, projectstore.SettingReviewConfig, string(b))
}

func saveCommands(ctx context.Context, db *projectstore.DB, in *[]projcfg.Command) error {
	if in == nil {
		return nil
	}
	b, err := json.Marshal(*in)
	if err != nil {
		return err
	}
	return db.SetSetting(ctx, projectstore.SettingCommands, string(b))
}

// checkSessionSettings validates a session_settings field (nil: not provided).
func checkSessionSettings(in *projectstore.SessionsSettings) error {
	if in == nil {
		return nil
	}
	if err := in.Validate(); err != nil {
		return invalid("%s", err.Error())
	}
	return nil
}

// saveSessionSettings merges a session_settings patch into the stored setting.
func saveSessionSettings(ctx context.Context, db *projectstore.DB, in *projectstore.SessionsSettings) error {
	if in == nil {
		return nil
	}
	return db.SetSessionsSettings(ctx, db.SessionsSettings(ctx).Merge(*in))
}
