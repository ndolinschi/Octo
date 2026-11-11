package local

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
)

// ToolSearchFiles is a read-only text search. It is not part of AllTools: only
// callers that name it get it.
const ToolSearchFiles = "search_files"

const (
	searchDefaultResults = 100
	searchMaxResults     = 200
	searchMaxFileBytes   = 1 << 20
	searchLineRunes      = 200
)

const searchProps = `"pattern":{"type":"string","description":"Regular expression (RE2); plain text works"},` +
	`"path":{"type":"string","description":"File or directory to search, relative to the folder; defaults to the folder root"},` +
	`"max_results":{"type":"integer","description":"Maximum matching lines to return; default 100, at most 200"}`

var skipDirs = map[string]bool{".git": true, "node_modules": true}

func searchFilesHandler(rs *rootSet) tools.Handler {
	return func(ctx context.Context, input json.RawMessage) (string, bool, error) {
		var in struct {
			Pattern    string `json:"pattern"`
			Path       string `json:"path"`
			Folder     string `json:"folder"`
			MaxResults int    `json:"max_results"`
		}
		if err := json.Unmarshal(input, &in); err != nil {
			return err.Error(), true, nil
		}
		re, err := regexp.Compile(in.Pattern)
		if in.Pattern == "" || err != nil {
			return "pattern must be a non-empty regular expression", true, nil
		}
		limit := in.MaxResults
		if limit < 1 {
			limit = searchDefaultResults
		}
		limit = min(limit, searchMaxResults)
		rel := in.Path
		if rel == "" {
			rel = "."
		}
		root, start, err := rs.resolve(in.Folder, rel)
		if err != nil {
			return err.Error(), true, nil
		}
		var out strings.Builder
		found, truncated := 0, false
		walkErr := filepath.WalkDir(start, func(p string, d fs.DirEntry, err error) error {
			if cerr := ctx.Err(); cerr != nil {
				return cerr
			}
			if err != nil {
				return nil
			}
			if d.IsDir() {
				if p != start && skipDirs[d.Name()] {
					return filepath.SkipDir
				}
				return nil
			}
			if !d.Type().IsRegular() { // symlinks could leave the root
				return nil
			}
			name, rerr := filepath.Rel(root, p)
			if rerr != nil {
				return nil
			}
			n, more := searchFile(p, filepath.ToSlash(name), re, limit-found, &out)
			found += n
			if more || found >= limit {
				truncated = true
				return filepath.SkipAll
			}
			return nil
		})
		if walkErr != nil {
			return walkErr.Error(), true, nil
		}
		if found == 0 {
			return "no matches", false, nil
		}
		if truncated {
			fmt.Fprintf(&out, "[search_files: stopped at %d matching lines; narrow the pattern or path]\n", found)
		}
		return out.String(), false, nil
	}
}

// searchFile appends up to room matching lines of the file at path to out and
// reports how many it added and whether there were more.
func searchFile(path, name string, re *regexp.Regexp, room int, out *strings.Builder) (added int, more bool) {
	info, err := os.Stat(path)
	if err != nil || info.Size() > searchMaxFileBytes {
		return 0, false
	}
	data, err := os.ReadFile(path)
	if err != nil || bytes.IndexByte(data[:min(len(data), 8192)], 0) >= 0 {
		return 0, false
	}
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 64*1024), searchMaxFileBytes)
	for line := 1; sc.Scan(); line++ {
		text := sc.Text()
		if !re.MatchString(text) {
			continue
		}
		if added >= room {
			return added, true
		}
		if r := []rune(text); len(r) > searchLineRunes {
			text = string(r[:searchLineRunes]) + "..."
		}
		fmt.Fprintf(out, "%s:%d: %s\n", name, line, strings.TrimRight(text, "\r"))
		added++
	}
	return added, false
}
