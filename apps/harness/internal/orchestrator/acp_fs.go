package orchestrator

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/files"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools/local"
)

// ReadTextFile serves fs/read_text_file confined to the project's folders.
func (s *acpSession) ReadTextFile(_ context.Context, req acp.ReadTextFileParams) (string, error) {
	root, label, rel, err := s.rt.locate(req.Path)
	if err != nil {
		s.deny(req.Path, err)
		return "", err
	}
	content, _, err := files.Read(root, rel)
	if err != nil {
		return "", fmt.Errorf("read %s/%s: %w", label, rel, err)
	}
	return sliceLines(content, req.Line, req.Limit), nil
}

// WriteTextFile serves fs/write_text_file: confined, atomic, missing parent
// directories created, and announced as file.changed.
func (s *acpSession) WriteTextFile(_ context.Context, req acp.WriteTextFileParams) error {
	root, label, rel, err := s.rt.locate(req.Path)
	if err != nil {
		s.deny(req.Path, err)
		return err
	}
	abs, err := local.Resolve(root, rel)
	if err != nil {
		s.deny(req.Path, err)
		return fmt.Errorf("path %q is outside the project folders: %w", req.Path, err)
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return fmt.Errorf("create parent directory: %w", err)
	}
	if _, err := files.Write(root, rel, req.Content, nil); err != nil {
		return fmt.Errorf("write %s/%s: %w", label, rel, err)
	}
	s.rt.publish(events.FileChanged, map[string]any{"folder": label, "path": rel, "source": events.SourceAgent})
	return nil
}

func (s *acpSession) deny(path string, err error) {
	slog.Warn("acp file request refused", "agent_id", s.agentID, "agent", s.label, "path", path, "err", err)
}

// locate maps an absolute path onto one of the project's folders, returning
// the folder root, its label and the slash path relative to it. Symlink escape
// is rejected later by internal/files.
func (rt *runtime) locate(abs string) (root, label, rel string, err error) {
	if !filepath.IsAbs(abs) {
		return "", "", "", fmt.Errorf("path %q must be absolute", abs)
	}
	clean := filepath.Clean(abs)
	for _, f := range rt.folders {
		for _, base := range folderBases(f.Path) {
			r, relErr := filepath.Rel(base, clean)
			if relErr != nil || r == ".." || strings.HasPrefix(r, ".."+string(filepath.Separator)) {
				continue
			}
			if r == "." {
				return "", "", "", fmt.Errorf("path %q is a folder root, not a file", abs)
			}
			return f.Path, f.Label, filepath.ToSlash(r), nil
		}
	}
	return "", "", "", fmt.Errorf("path %q is outside the project folders", abs)
}

// folderBases lists a folder path and its symlink-resolved form.
func folderBases(path string) []string {
	bases := []string{filepath.Clean(path)}
	if real, err := filepath.EvalSymlinks(path); err == nil && real != bases[0] {
		bases = append(bases, real)
	}
	return bases
}

// sliceLines applies ACP's 1-based line and limit to content.
func sliceLines(content string, line, limit *int) string {
	if line == nil && limit == nil {
		return content
	}
	lines := strings.SplitAfter(content, "\n")
	if n := len(lines); n > 0 && lines[n-1] == "" {
		lines = lines[:n-1]
	}
	start := 0
	if line != nil && *line > 1 {
		start = *line - 1
	}
	if start >= len(lines) {
		return ""
	}
	end := len(lines)
	if limit != nil && *limit >= 0 && start+*limit < end {
		end = start + *limit
	}
	return strings.Join(lines[start:end], "")
}
