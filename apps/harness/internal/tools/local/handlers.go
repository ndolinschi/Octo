package local

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
)

const bashTimeout = 30 * time.Second

var bashTrustWarn sync.Once

func bashHandler(rs *rootSet) tools.Handler {
	return func(ctx context.Context, input json.RawMessage) (string, bool, error) {
		bashTrustWarn.Do(func() {
			slog.Warn("bash runs real shell commands with the harness process privileges; not sandboxed")
		})
		var in struct {
			Command string `json:"command"`
			Folder  string `json:"folder"`
		}
		if err := json.Unmarshal(input, &in); err != nil {
			return err.Error(), true, nil
		}
		if strings.TrimSpace(in.Command) == "" {
			return "command required", true, nil
		}
		dir, err := rs.pick(in.Folder)
		if err != nil {
			return err.Error(), true, nil
		}
		runCtx, cancel := context.WithTimeout(ctx, bashTimeout)
		defer cancel()
		cmd := exec.CommandContext(runCtx, "bash", "-c", in.Command)
		cmd.Dir = dir
		var stdout, stderr bytes.Buffer
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr
		err = cmd.Run()
		out := stdout.String()
		if se := stderr.String(); se != "" {
			if out != "" {
				out += "\n"
			}
			out += se
		}
		if err != nil {
			if out == "" {
				out = err.Error()
			}
			return out, true, nil
		}
		return out, false, nil
	}
}

// readFooterReserve is the room read_file keeps for its own truncation footer.
const readFooterReserve = 300

func readFileHandler(rs *rootSet, lim tools.Limits) tools.Handler {
	lim = lim.Resolved()
	return func(ctx context.Context, input json.RawMessage) (string, bool, error) {
		var in struct {
			Path   string `json:"path"`
			Folder string `json:"folder"`
			Offset *int   `json:"offset"`
			Limit  *int   `json:"limit"`
		}
		if err := json.Unmarshal(input, &in); err != nil {
			return err.Error(), true, nil
		}
		offset, limit := 1, lim.ReadLines
		if in.Offset != nil && *in.Offset != 0 {
			offset = *in.Offset
		}
		if in.Limit != nil && *in.Limit != 0 {
			limit = *in.Limit
		}
		if offset < 1 || limit < 1 {
			return "offset (1-based first line) and limit (line count) must be positive", true, nil
		}
		_, path, err := rs.resolve(in.Folder, in.Path)
		if err != nil {
			return err.Error(), true, nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err.Error(), true, nil
		}
		return sliceFile(string(data), offset, limit, lim.ResultBytes)
	}
}

// sliceFile returns lines [offset, offset+limit) of content, 1-based, cut
// further to maxBytes. When anything is left out it appends a footer with the
// shown range, the total line count and the offset to continue from.
func sliceFile(content string, offset, limit, maxBytes int) (string, bool, error) {
	total := countLines(content)
	if offset > total && total > 0 {
		return fmt.Sprintf("offset %d is past the end of the file (%d lines)", offset, total), true, nil
	}
	budget := max(maxBytes-readFooterReserve, 1)
	var b strings.Builder
	rest := content
	for skipped := 1; skipped < offset && rest != ""; skipped++ {
		_, rest, _ = cutLine(rest)
	}
	last := offset - 1 // last fully or partly shown line number
	cut := false
	for rest != "" && last-offset+1 < limit {
		line, after, _ := cutLine(rest)
		if b.Len()+len(line) > budget {
			if b.Len() == 0 { // one line longer than the budget: show its head
				b.WriteString(clipRunes(line, budget))
				last++
			}
			cut = true
			break
		}
		b.WriteString(line)
		last++
		rest = after
	}
	if last-offset+1 >= limit && rest != "" {
		cut = true
	}
	if !cut {
		return b.String(), false, nil
	}
	fmt.Fprintf(&b, "\n[read_file: showed lines %d-%d of %d total. Call read_file again with offset=%d to continue.]",
		offset, last, total, last+1)
	return b.String(), false, nil
}

func countLines(s string) int {
	if s == "" {
		return 0
	}
	n := strings.Count(s, "\n")
	if !strings.HasSuffix(s, "\n") {
		n++
	}
	return n
}

// cutLine splits off the first line, keeping its newline.
func cutLine(s string) (line, rest string, ok bool) {
	i := strings.IndexByte(s, '\n')
	if i < 0 {
		return s, "", false
	}
	return s[:i+1], s[i+1:], true
}

func clipRunes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

func writeFileHandler(rs *rootSet) tools.Handler {
	return func(ctx context.Context, input json.RawMessage) (string, bool, error) {
		var in struct {
			Path    string `json:"path"`
			Content string `json:"content"`
			Folder  string `json:"folder"`
		}
		if err := json.Unmarshal(input, &in); err != nil {
			return err.Error(), true, nil
		}
		_, path, err := rs.resolve(in.Folder, in.Path)
		if err != nil {
			return err.Error(), true, nil
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err.Error(), true, nil
		}
		if err := os.WriteFile(path, []byte(in.Content), 0o644); err != nil {
			return err.Error(), true, nil
		}
		return "ok", false, nil
	}
}

func listDirHandler(rs *rootSet) tools.Handler {
	return func(ctx context.Context, input json.RawMessage) (string, bool, error) {
		var in struct {
			Path   string `json:"path"`
			Folder string `json:"folder"`
		}
		if err := json.Unmarshal(input, &in); err != nil {
			return err.Error(), true, nil
		}
		rel := in.Path
		if rel == "" {
			rel = "."
		}
		_, path, err := rs.resolve(in.Folder, rel)
		if err != nil {
			return err.Error(), true, nil
		}
		entries, err := os.ReadDir(path)
		if err != nil {
			return err.Error(), true, nil
		}
		var b strings.Builder
		for i, e := range entries {
			if i > 0 {
				b.WriteByte('\n')
			}
			name := e.Name()
			if e.IsDir() {
				name += "/"
			}
			b.WriteString(name)
		}
		return b.String(), false, nil
	}
}
