package local

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

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
			return tools.CapString(out), true, nil
		}
		return tools.CapString(out), false, nil
	}
}

func readFileHandler(rs *rootSet) tools.Handler {
	return func(ctx context.Context, input json.RawMessage) (string, bool, error) {
		var in struct {
			Path   string `json:"path"`
			Folder string `json:"folder"`
		}
		if err := json.Unmarshal(input, &in); err != nil {
			return err.Error(), true, nil
		}
		_, path, err := rs.resolve(in.Folder, in.Path)
		if err != nil {
			return err.Error(), true, nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err.Error(), true, nil
		}
		return string(tools.CapBytes(data)), false, nil
	}
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
