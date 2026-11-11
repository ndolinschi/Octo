// Package activity builds the one-line description of what an agent is doing
// now ("Reading src/x.go", "Running `pnpm test`") that the UI shows instead of
// a bare spinner.
package activity

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

// Kinds of the agent.activity event.
const (
	Thinking        = "thinking"
	Tool            = "tool"
	Text            = "text"
	WaitingApproval = "waiting_approval"
	Idle            = "idle"
	// Quiet: nothing at all has arrived from the agent for a while.
	Quiet = "quiet"
)

const maxLabel = 80

// Clip shortens s to n runes with an ellipsis, on one line.
func Clip(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return strings.TrimSpace(string(r[:n-1])) + "…"
}

func command(c string) string { return "Running `" + strings.ReplaceAll(Clip(c, 60), "`", "'") + "`" }

// ForTool labels a call of one of the harness's own tools, from its name and arguments.
func ForTool(name string, input json.RawMessage) string {
	var a struct {
		Path, Command, Pattern, Query, Title, Task, Name string
		ID                                               any
	}
	_ = json.Unmarshal(input, &a)
	path := func(p string) string {
		if p == "" || p == "." {
			return "the project folder"
		}
		return Clip(p, 60)
	}
	switch name {
	case "bash", "run_command":
		if a.Command != "" {
			return command(a.Command)
		}
		return "Running a command"
	case "read_file":
		return "Reading " + path(a.Path)
	case "write_file":
		return "Writing " + path(a.Path)
	case "list_dir":
		return "Listing " + path(a.Path)
	case "search_files":
		if a.Pattern != "" {
			return `Searching for "` + Clip(a.Pattern, 50) + `"`
		}
		return "Searching the files"
	case "spawn_agent":
		switch {
		case a.Title != "":
			return "Delegating: " + Clip(a.Title, 60)
		case a.Task != "":
			return "Delegating: " + Clip(a.Task, 60)
		}
		return "Delegating a task"
	case "memory_search":
		if a.Query != "" {
			return `Searching memory for "` + Clip(a.Query, 50) + `"`
		}
		return "Searching memory"
	case "recall_message":
		return "Recalling an earlier message"
	case "memory":
		return "Updating memory"
	case "task_update":
		return "Updating the task record"
	case "save_note":
		return "Saving a note"
	case "read_notes":
		return "Reading notes"
	case "request_input":
		return "Asking you for input"
	}
	return Clip("Using "+name, maxLabel)
}

// ForACP labels a tool call an ACP agent announced, from its title, kind and
// first location; paths under cwd are shown relative to it.
func ForACP(kind, title, loc, cwd string) string {
	title = strings.TrimSpace(title)
	where := loc
	if where != "" && cwd != "" {
		if rel, err := filepath.Rel(cwd, where); err == nil && !strings.HasPrefix(rel, "..") {
			where = rel
		}
	}
	where = Clip(where, 60)
	switch kind {
	case "read":
		if where != "" {
			return "Reading " + where
		}
	case "edit":
		if where != "" {
			return "Editing " + where
		}
	case "delete":
		if where != "" {
			return "Deleting " + where
		}
	case "move":
		if where != "" {
			return "Moving " + where
		}
	case "execute":
		if title != "" {
			return command(strings.Trim(title, "`"))
		}
		return "Running a command"
	case "search":
		if title != "" {
			return Clip(title, maxLabel)
		}
		return "Searching"
	case "fetch":
		if title != "" {
			return Clip(title, maxLabel)
		}
		return "Fetching"
	case "think":
		return "Thinking"
	}
	if title != "" {
		return Clip(title, maxLabel)
	}
	return "Using a tool"
}
