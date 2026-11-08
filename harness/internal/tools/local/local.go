package local

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/ndolinschi/Octo/harness/internal/tools"
)

const bashTimeout = 30 * time.Second

var schemaBash = json.RawMessage(`{"type":"object","properties":{"command":{"type":"string","description":"Shell command to run"}},"required":["command"]}`)
var schemaReadFile = json.RawMessage(`{"type":"object","properties":{"path":{"type":"string","description":"Relative path under workspace"}},"required":["path"]}`)
var schemaWriteFile = json.RawMessage(`{"type":"object","properties":{"path":{"type":"string","description":"Relative path under workspace"},"content":{"type":"string","description":"File contents"}},"required":["path","content"]}`)
var schemaListDir = json.RawMessage(`{"type":"object","properties":{"path":{"type":"string","description":"Relative directory path; defaults to workspace root"}}}`)

func Register(reg *tools.Registry, workspace string) error {
	absWorkspace, err := filepath.Abs(workspace)
	if err != nil {
		return fmt.Errorf("workspace: %w", err)
	}
	ws := absWorkspace

	toolsDefs := []tools.Def{
		{
			Name:        "bash",
			Description: "Run a shell command in the workspace",
			InputSchema: schemaBash,
			Handle:      bashHandler(ws),
		},
		{
			Name:        "read_file",
			Description: "Read a text file under the workspace",
			InputSchema: schemaReadFile,
			Handle:      readFileHandler(ws),
		},
		{
			Name:        "write_file",
			Description: "Write a text file under the workspace",
			InputSchema: schemaWriteFile,
			Handle:      writeFileHandler(ws),
		},
		{
			Name:        "list_dir",
			Description: "List a directory under the workspace",
			InputSchema: schemaListDir,
			Handle:      listDirHandler(ws),
		},
	}
	for _, d := range toolsDefs {
		if err := reg.Register(d); err != nil {
			return err
		}
	}
	return nil
}

func bashHandler(workspace string) tools.Handler {
	return func(ctx context.Context, input json.RawMessage) (string, bool, error) {
		var in struct {
			Command string `json:"command"`
		}
		if err := json.Unmarshal(input, &in); err != nil {
			return err.Error(), true, nil
		}
		if strings.TrimSpace(in.Command) == "" {
			return "command required", true, nil
		}
		runCtx, cancel := context.WithTimeout(ctx, bashTimeout)
		defer cancel()
		cmd := exec.CommandContext(runCtx, "bash", "-c", in.Command)
		cmd.Dir = workspace
		var stdout, stderr bytes.Buffer
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr
		err := cmd.Run()
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

func readFileHandler(workspace string) tools.Handler {
	return func(ctx context.Context, input json.RawMessage) (string, bool, error) {
		var in struct {
			Path string `json:"path"`
		}
		if err := json.Unmarshal(input, &in); err != nil {
			return err.Error(), true, nil
		}
		path, err := resolveUnderWorkspace(workspace, in.Path)
		if err != nil {
			return err.Error(), true, nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err.Error(), true, nil
		}
		return string(data), false, nil
	}
}

func writeFileHandler(workspace string) tools.Handler {
	return func(ctx context.Context, input json.RawMessage) (string, bool, error) {
		var in struct {
			Path    string `json:"path"`
			Content string `json:"content"`
		}
		if err := json.Unmarshal(input, &in); err != nil {
			return err.Error(), true, nil
		}
		path, err := resolveUnderWorkspace(workspace, in.Path)
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

func listDirHandler(workspace string) tools.Handler {
	return func(ctx context.Context, input json.RawMessage) (string, bool, error) {
		var in struct {
			Path string `json:"path"`
		}
		_ = json.Unmarshal(input, &in)
		rel := in.Path
		if rel == "" {
			rel = "."
		}
		path, err := resolveUnderWorkspace(workspace, rel)
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

func resolveUnderWorkspace(workspace, rel string) (string, error) {
	if rel == "" {
		return "", fmt.Errorf("path required")
	}
	if filepath.IsAbs(rel) {
		return "", fmt.Errorf("path must be relative to workspace")
	}
	clean := filepath.Clean(rel)
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path escapes workspace")
	}
	joined := filepath.Join(workspace, clean)
	absTarget, err := filepath.Abs(joined)
	if err != nil {
		return "", err
	}
	absWorkspace, err := filepath.Abs(workspace)
	if err != nil {
		return "", err
	}
	if absTarget != absWorkspace && !strings.HasPrefix(absTarget, absWorkspace+string(filepath.Separator)) {
		return "", fmt.Errorf("path escapes workspace")
	}
	return absTarget, nil
}
