package local

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/ndolinschi/Octo/apps/harness/internal/childenv"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
)

const bashTimeout = 30 * time.Second

var bashTrustWarn sync.Once

// bashWaitDelay is how long a cancelled command's output pipes may stay open before Run returns anyway.
const bashWaitDelay = 500 * time.Millisecond

func bashHandler(rs *rootSet, lim tools.Limits) tools.Handler {
	return func(ctx context.Context, input json.RawMessage) (string, bool, error) {
		bashTrustWarn.Do(func() {
			slog.Warn("bash runs real shell commands with the harness process privileges; not sandboxed")
		})
		var in struct {
			Command string            `json:"command"`
			Folder  string            `json:"folder"`
			Env     map[string]string `json:"env"`
		}
		if err := json.Unmarshal(input, &in); err != nil {
			return err.Error(), true, nil
		}
		extra, resolved := ExtraEnv(ctx)
		if len(in.Env) > 0 && !resolved {
			return "env is not available here: it needs the harness's secret store", true, nil
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
		killGroupOnCancel(cmd)
		// Whatever still holds the output pipes after the cancel does not keep the call open.
		cmd.WaitDelay = bashWaitDelay
		cmd.Dir = dir
		// Same allow-list as plugin processes: no provider keys or other secrets.
		cmd.Env = childenv.Build(os.Environ(), extra)
		capBytes := max(lim.Resolved().ResultBytes*4, 2<<20)
		stdout := cappedBuffer{limit: capBytes}
		stderr := cappedBuffer{limit: capBytes}
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
			return failedOutput(out, err, runCtx.Err() == context.DeadlineExceeded, lim), true, nil
		}
		return out, false, nil
	}
}

// cappedBuffer buffers up to limit bytes and discards the rest while always returning len(p), nil
// so child processes writing to stdout/stderr never block on a full pipe.
type cappedBuffer struct {
	buf       bytes.Buffer
	limit     int
	truncated bool
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	if c.buf.Len() < c.limit {
		keep := min(len(p), c.limit-c.buf.Len())
		c.buf.Write(p[:keep])
		if keep < len(p) {
			c.truncated = true
		}
	} else if len(p) > 0 {
		c.truncated = true
	}
	return len(p), nil
}

func (c *cappedBuffer) String() string {
	if !c.truncated {
		return c.buf.String()
	}
	return c.buf.String() + "\n[output truncated: stream exceeded buffer cap]"
}

// failedOutput is a failed command's result: its output, then always a last line saying how it ended ("exit
// status N" for an exit code, which the UI reads as "Failed (exit N)"; "signal: killed" and the like otherwise).
// The output is cut first when it would not leave room for that line under the result cap, so the cap applied
// later never cuts the line away.
func failedOutput(out string, err error, timedOut bool, lim tools.Limits) string {
	line := err.Error()
	if timedOut {
		line += fmt.Sprintf(" (timed out after %s)", bashTimeout)
	}
	if out == "" {
		return line
	}
	room := lim.Resolved().ResultBytes - len(line) - 1
	out = tools.Truncate(out, max(room, 0), tools.ResultHint)
	if !strings.HasSuffix(out, "\n") {
		out += "\n"
	}
	return out + line
}

// readFooterReserve is the room read_file keeps for its own truncation footer.
const readFooterReserve = 300

// maxReadFileBytes bounds how much read_file will read into memory from a single file.
const maxReadFileBytes = 16 << 20

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
		data, err := readRegularFile(path, maxReadFileBytes)
		if err != nil {
			return err.Error(), true, nil
		}
		return sliceFile(string(data), offset, limit, lim.ResultBytes)
	}
}

func readRegularFile(path string, maxBytes int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, fmt.Errorf("not a regular file: %s", filepath.Base(path))
	}
	if fi.Size() > maxBytes {
		return nil, fmt.Errorf("file is too large to read (%d bytes; max %d bytes)", fi.Size(), maxBytes)
	}
	data, err := io.ReadAll(io.LimitReader(f, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("file is too large to read (max %d bytes)", maxBytes)
	}
	return data, nil
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
		_, path, err := rs.resolveWrite(in.Folder, in.Path)
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
