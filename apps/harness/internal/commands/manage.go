package commands

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/ndolinschi/Octo/apps/harness/internal/projcfg"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

const maxAdhocNameRunes = 48

// StartAdhoc runs a user-supplied shell command in the project's folder (or a
// subfolder/label under it). Like Start, it is only reachable from the user's
// HTTP bridge routes.
func (s *Service) StartAdhoc(ctx context.Context, pid, name, command, cwd string) (projectstore.CommandRun, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return projectstore.CommandRun{}, err
	}
	command = strings.TrimSpace(command)
	if command == "" {
		return projectstore.CommandRun{}, usererr.Generic("invalid_request", "command is required")
	}
	name = strings.TrimSpace(name)
	if name == "" {
		name = defaultRunName(command)
	} else if utf8.RuneCountInString(name) > maxAdhocNameRunes {
		r := []rune(name)
		name = string(r[:maxAdhocNameRunes])
	}
	cmdDef := projcfg.Command{Name: name, Command: command, Cwd: strings.TrimSpace(cwd)}
	dir, err := resolveDir(ctx, db, cmdDef, "")
	if err != nil {
		return projectstore.CommandRun{}, err
	}
	return s.spawn(ctx, db, pid, cmdDef, dir, "")
}

func defaultRunName(command string) string {
	line := command
	if i := strings.IndexAny(line, "\r\n"); i >= 0 {
		line = line[:i]
	}
	line = strings.Join(strings.Fields(line), " ")
	if utf8.RuneCountInString(line) > maxAdhocNameRunes {
		r := []rune(line)
		return string(r[:maxAdhocNameRunes-1]) + "…"
	}
	return line
}

// StopWith ends a run: when force is true it sends SIGKILL immediately to the
// process group; otherwise SIGTERM followed by SIGKILL after StopGrace.
func (s *Service) StopWith(ctx context.Context, pid, rid string, force bool) (projectstore.CommandRun, error) {
	r := s.activeRun(pid, rid)
	if r == nil {
		return s.Get(ctx, pid, rid)
	}
	r.mu.Lock()
	r.stopRequested = true
	r.mu.Unlock()
	if force {
		signalGroup(r.cmd, true)
		select {
		case <-r.done:
		case <-time.After(5 * time.Second):
		case <-ctx.Done():
		}
		return s.Get(ctx, pid, rid)
	}
	signalGroup(r.cmd, false)
	select {
	case <-r.done:
	case <-time.After(s.grace):
		signalGroup(r.cmd, true)
		select {
		case <-r.done:
		case <-time.After(5 * time.Second):
		case <-ctx.Done():
		}
	case <-ctx.Done():
	}
	return s.Get(ctx, pid, rid)
}

// Restart stops rid if it is still running, then starts a fresh run with the
// same name, command, working directory and review (if any).
func (s *Service) Restart(ctx context.Context, pid, rid string) (projectstore.CommandRun, error) {
	prev, err := s.Get(ctx, pid, rid)
	if err != nil {
		return projectstore.CommandRun{}, err
	}
	if prev.Status == projectstore.RunRunning {
		if _, err := s.StopWith(ctx, pid, rid, false); err != nil {
			return projectstore.CommandRun{}, err
		}
	}
	db, err := s.db(ctx, pid)
	if err != nil {
		return projectstore.CommandRun{}, err
	}
	dir, err := resolveRestartDir(ctx, db, prev)
	if err != nil {
		return projectstore.CommandRun{}, err
	}
	name := strings.TrimSpace(prev.Name)
	if name == "" {
		name = defaultRunName(prev.Command)
	}
	return s.spawn(ctx, db, pid, projcfg.Command{Name: name, Command: prev.Command}, dir, prev.ReviewID)
}

func resolveRestartDir(ctx context.Context, db *projectstore.DB, prev projectstore.CommandRun) (string, error) {
	if prev.ReviewID != "" {
		base, err := resolveDir(ctx, db, projcfg.Command{}, prev.ReviewID)
		if err != nil {
			return "", err
		}
		if withinRoot(base, prev.Cwd) {
			return prev.Cwd, nil
		}
		return base, nil
	}
	folders, err := db.Folders(ctx)
	if err != nil {
		return "", err
	}
	for _, f := range folders {
		if withinRoot(f.Path, prev.Cwd) {
			return prev.Cwd, nil
		}
	}
	return resolveDir(ctx, db, projcfg.Command{}, "")
}

func withinRoot(root, candidate string) bool {
	if root == "" || candidate == "" {
		return false
	}
	realRoot, err1 := filepath.EvalSymlinks(root)
	realCand, err2 := filepath.EvalSymlinks(candidate)
	if err1 != nil || err2 != nil {
		return false
	}
	fi, err := os.Stat(realCand)
	if err != nil || !fi.IsDir() {
		return false
	}
	rel, err := filepath.Rel(realRoot, realCand)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
