// Package accounts keeps the extra logins (accounts) of ACP agents: a name, a
// slug and an isolation folder per account, stored in {data}/agent-accounts.json.
// It never stores a secret and never reads what a CLI writes into the folder.
// Every change is expanded into derived agents of the plugin registry.
package accounts

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// FileName is the store's file in the data folder.
const FileName = "agent-accounts.json"

// fileVersion is the only version this harness reads and writes.
const fileVersion = 1

// Account is one stored account of a base agent. ID "" is the agent's own
// (default) login, which has no record; only its name is stored.
type Account struct {
	Agent     string    `json:"agent"`
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Dir       string    `json:"dir"`
	Owned     bool      `json:"owned"`
	CreatedAt time.Time `json:"created_at"`
}

// file is the JSON form of the store.
type file struct {
	Version      int               `json:"version"`
	Accounts     []Account         `json:"accounts"`
	DefaultNames map[string]string `json:"default_names"`
}

// ErrFileUnusable: the accounts file does not parse or was written by a newer
// harness. It is left alone, and every change of accounts is refused.
var ErrFileUnusable = errors.New("the accounts file cannot be used")

// readFile loads path. A missing file is an empty store; a file of another
// version, or one that does not parse, is ErrFileUnusable (never rewritten).
func readFile(path string) (file, error) {
	empty := file{Version: fileVersion, Accounts: []Account{}, DefaultNames: map[string]string{}}
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return empty, nil
	}
	if err != nil {
		return file{}, fmt.Errorf("read %s: %w", FileName, err)
	}
	var f file
	if err := json.Unmarshal(b, &f); err != nil {
		return file{}, fmt.Errorf("%w: %w", ErrFileUnusable, err)
	}
	if f.Version != fileVersion {
		return file{}, fmt.Errorf("%w: unknown version %d", ErrFileUnusable, f.Version)
	}
	if f.Accounts == nil {
		f.Accounts = []Account{}
	}
	if f.DefaultNames == nil {
		f.DefaultNames = map[string]string{}
	}
	return f, nil
}

// writeFile replaces path atomically (temp file and rename): folder 0700, file 0600.
func writeFile(path string, f file) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create data folder: %w", err)
	}
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return fmt.Errorf("encode %s: %w", FileName, err)
	}
	tmp, err := os.CreateTemp(dir, ".agent-accounts-*.json")
	if err != nil {
		return fmt.Errorf("write %s: %w", FileName, err)
	}
	name := tmp.Name()
	defer func() { _ = os.Remove(name) }()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write %s: %w", FileName, err)
	}
	if _, err := tmp.Write(b); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write %s: %w", FileName, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("write %s: %w", FileName, err)
	}
	if err := os.Rename(name, path); err != nil {
		return fmt.Errorf("write %s: %w", FileName, err)
	}
	return nil
}
