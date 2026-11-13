// Package projcfg holds the shapes of the per-project settings that are not
// part of the project row: the named commands (decision 68) and the review
// configuration. They are stored as JSON in the project's settings table and
// travel as fields of the project (`commands`, `review`). The package has no
// dependencies on anything that starts a process or talks to a code host, so
// both the project service and the review and command services can use it.
package projcfg

import (
	"encoding/json"
	"fmt"
	"path"
	"strings"
	"unicode/utf8"
)

// Limits of the settings.
const (
	MaxCommands   = 50
	MaxPinned     = 2
	MaxNameRunes  = 60
	MaxCommandLen = 4096
	MaxCwdLen     = 512
)

// Command is a named shell command of a project. The harness only ever runs it
// when the user asks (POST …/commands/{name}/run); no agent can.
type Command struct {
	// Name is what the user sees and what the run route names (unique in a project, case-insensitive).
	Name string `json:"name"`
	// Command is run by `bash -c` with the shell tool's environment rules.
	Command string `json:"command"`
	// Cwd is the working directory: the label of one of the project's folders, or a path
	// relative to the first folder ("" = the first folder). With a review it is relative
	// to the review's worktree.
	Cwd string `json:"cwd,omitempty"`
	// Pinned: a quiet button in the top row (at most two per project).
	Pinned bool `json:"pinned,omitempty"`
}

// ValidateCommands checks a project's command list.
func ValidateCommands(list []Command) error {
	if len(list) > MaxCommands {
		return fmt.Errorf("commands: at most %d commands", MaxCommands)
	}
	seen := map[string]bool{}
	pinned := 0
	for i := range list {
		c := &list[i]
		c.Name = strings.TrimSpace(c.Name)
		if c.Name == "" {
			return fmt.Errorf("commands[%d].name is required", i)
		}
		if utf8.RuneCountInString(c.Name) > MaxNameRunes {
			return fmt.Errorf("commands[%d].name is longer than %d characters", i, MaxNameRunes)
		}
		if strings.ContainsAny(c.Name, "/\\") || hasControl(c.Name) {
			return fmt.Errorf("commands[%d].name must not contain slashes or control characters", i)
		}
		key := strings.ToLower(c.Name)
		if seen[key] {
			return fmt.Errorf("commands: the name %q is used twice", c.Name)
		}
		seen[key] = true
		if strings.TrimSpace(c.Command) == "" {
			return fmt.Errorf("commands[%d].command is required", i)
		}
		if len(c.Command) > MaxCommandLen || strings.ContainsRune(c.Command, 0) || !utf8.ValidString(c.Command) {
			return fmt.Errorf("commands[%d].command is too long or not text", i)
		}
		if err := validCwd(c.Cwd); err != nil {
			return fmt.Errorf("commands[%d].cwd %w", i, err)
		}
		if c.Pinned {
			pinned++
		}
	}
	if pinned > MaxPinned {
		return fmt.Errorf("commands: at most %d commands can be pinned", MaxPinned)
	}
	return nil
}

func hasControl(s string) bool {
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

// validCwd: empty, a folder label, or a relative path that stays inside the folder.
func validCwd(cwd string) error {
	if cwd == "" {
		return nil
	}
	if len(cwd) > MaxCwdLen || strings.ContainsRune(cwd, 0) || hasControl(cwd) {
		return fmt.Errorf("is too long or not text")
	}
	if strings.HasPrefix(cwd, "/") || strings.HasPrefix(cwd, "\\") || strings.Contains(cwd, ":\\") {
		return fmt.Errorf("must be a folder label or a path relative to the folder, not absolute")
	}
	for _, seg := range strings.Split(path.Clean(strings.ReplaceAll(cwd, "\\", "/")), "/") {
		if seg == ".." {
			return fmt.Errorf("must stay inside the project's folder")
		}
	}
	return nil
}

// ParseCommands reads the stored JSON; anything unreadable is an empty list.
func ParseCommands(raw string) []Command {
	var list []Command
	if raw == "" || json.Unmarshal([]byte(raw), &list) != nil || list == nil {
		return []Command{}
	}
	return list
}

// Find returns the command with the name (case-insensitive).
func Find(list []Command, name string) (Command, bool) {
	for _, c := range list {
		if strings.EqualFold(c.Name, strings.TrimSpace(name)) {
			return c, true
		}
	}
	return Command{}, false
}
