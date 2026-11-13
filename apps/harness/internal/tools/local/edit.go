package local

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
)

// ToolEdit replaces text in a file; ToolGlob finds files by pattern. Both are
// part of AllTools.
const (
	ToolEdit = "edit"
	ToolGlob = "glob"
)

// maxEditFile is the largest file edit works on.
const maxEditFile = 4 << 20

const editProps = `"path":{"type":"string","description":"Relative path of an existing text file under the folder"},` +
	`"old_string":{"type":"string","description":"The exact text to replace, whitespace included; must occur exactly once unless replace_all is set"},` +
	`"new_string":{"type":"string","description":"The text to put in its place"},` +
	`"replace_all":{"type":"boolean","description":"Replace every occurrence of old_string; default false"}`

const globProps = `"pattern":{"type":"string","description":"Glob pattern, e.g. **/*.go or src/**/*.{ts,tsx}; ** matches any number of directories"},` +
	`"path":{"type":"string","description":"Directory to search in, relative to the folder; defaults to the folder root"}`

// ComputeEdit applies an exact-match replacement to content. It fails when
// old is empty or equals new, when it matches nowhere, and when it matches more
// than once unless replaceAll; n is the number of replacements made.
func ComputeEdit(content, old, new string, replaceAll bool) (out string, n int, err error) {
	switch {
	case old == "":
		return "", 0, fmt.Errorf("old_string must not be empty (to create or replace a whole file use write_file)")
	case old == new:
		return "", 0, fmt.Errorf("old_string and new_string are identical: nothing to change")
	}
	n = strings.Count(content, old)
	switch {
	case n == 0:
		return "", 0, fmt.Errorf("old_string was not found in the file: read it again and copy the text exactly, whitespace and line breaks included")
	case n > 1 && !replaceAll:
		return "", n, fmt.Errorf("old_string matches %d places: add surrounding lines so it matches exactly one, or set replace_all", n)
	}
	if replaceAll {
		return strings.ReplaceAll(content, old, new), n, nil
	}
	return strings.Replace(content, old, new, 1), 1, nil
}

// EditInput is the decoded input of the edit tool.
type EditInput struct {
	Path       string `json:"path"`
	Folder     string `json:"folder"`
	OldString  string `json:"old_string"`
	NewString  string `json:"new_string"`
	ReplaceAll bool   `json:"replace_all"`
}

// ReadTextFile reads a regular text file for editing (UTF-8 or at least NUL-free, at most 4 MB).
func ReadTextFile(abs string) (string, error) {
	fi, err := os.Stat(abs)
	if err != nil {
		return "", err
	}
	if !fi.Mode().IsRegular() {
		return "", fmt.Errorf("not a regular file")
	}
	if fi.Size() > maxEditFile {
		return "", fmt.Errorf("file is larger than %d MB: edit it with a command instead", maxEditFile>>20)
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return "", err
	}
	if bytes.IndexByte(data[:min(len(data), 8192)], 0) >= 0 {
		return "", fmt.Errorf("not a text file")
	}
	return string(data), nil
}

func editHandler(rs *rootSet) tools.Handler {
	return func(ctx context.Context, input json.RawMessage) (string, bool, error) {
		var in EditInput
		if err := json.Unmarshal(input, &in); err != nil {
			return err.Error(), true, nil
		}
		_, path, err := rs.resolve(in.Folder, in.Path)
		if err != nil {
			return err.Error(), true, nil
		}
		content, err := ReadTextFile(path)
		if err != nil {
			return in.Path + ": " + err.Error(), true, nil
		}
		out, n, err := ComputeEdit(content, in.OldString, in.NewString, in.ReplaceAll)
		if err != nil {
			return in.Path + ": " + err.Error(), true, nil
		}
		mode := os.FileMode(0o644)
		if fi, err := os.Stat(path); err == nil {
			mode = fi.Mode().Perm()
		}
		if err := os.WriteFile(path, []byte(out), mode); err != nil {
			return err.Error(), true, nil
		}
		if n == 1 {
			return "edited " + in.Path, false, nil
		}
		return fmt.Sprintf("edited %s: %d replacements", in.Path, n), false, nil
	}
}
