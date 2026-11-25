package project

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"unicode"

	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/gitx"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// MoveWorktreeInput is the body of POST /sessions/{sid}/worktree.
type MoveWorktreeInput struct {
	Branch       string `json:"branch"`
	BaseRef      string `json:"base_ref"`
	CarryChanges *bool  `json:"carry_changes"`
}

// MoveWorktreeResult is the answer of POST /sessions/{sid}/worktree.
type MoveWorktreeResult struct {
	Session   orchestrator.SessionView `json:"session"`
	Workspace projectstore.Workspace   `json:"workspace"`
}

// ListWorkspaces is GET /v1/projects/{pid}/workspaces.
func (s *Service) ListWorkspaces(ctx context.Context, pid string) ([]projectstore.Workspace, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return nil, err
	}
	list, err := db.ListWorkspaces(ctx)
	if err != nil {
		return nil, storeErr(err)
	}
	return list, nil
}

// MoveSessionToWorktree creates an isolated git worktree workspace and moves main session sid into it.
func (s *Service) MoveSessionToWorktree(ctx context.Context, pid, sid string, in MoveWorktreeInput) (MoveWorktreeResult, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return MoveWorktreeResult{}, err
	}
	if sid, err = s.mainSessionID(ctx, db, sid); err != nil {
		return MoveWorktreeResult{}, err
	}
	info, err := db.SessionInfoOf(ctx, sid)
	if err != nil {
		return MoveWorktreeResult{}, sessionErr(err)
	}
	if st, ok := s.turns.(SessionTurns); ok && (st.RunningSession(pid, sid) || st.ActiveSession(pid, sid)) {
		return MoveWorktreeResult{}, of(KindConflict, usererr.WorkspaceInUse())
	}
	if info.State == projectstore.SessionWorking || info.State == projectstore.SessionWaiting {
		return MoveWorktreeResult{}, of(KindConflict, usererr.WorkspaceInUse())
	}
	if info.Workspace != nil && info.Workspace.Kind == "worktree" {
		return MoveWorktreeResult{}, of(KindConflict, usererr.WorkspaceAlreadyWorktree(info.Workspace.ID))
	}
	branch := strings.TrimSpace(in.Branch)
	if branch == "" {
		branch = defaultWorktreeBranch(info)
	}
	if !gitx.ValidRefName(branch) {
		return MoveWorktreeResult{}, invalid("invalid branch name %q", branch)
	}
	carry := true
	if in.CarryChanges != nil {
		carry = *in.CarryChanges
	}
	folders, err := db.Folders(ctx)
	if err != nil {
		return MoveWorktreeResult{}, storeErr(err)
	}
	ws, err := s.createWorktreeForProject(ctx, db, folders, branch, in.BaseRef, carry)
	if err != nil {
		return MoveWorktreeResult{}, err
	}
	if err := db.SetSessionWorkspace(ctx, sid, ws.ID); err != nil {
		return MoveWorktreeResult{}, storeErr(err)
	}
	if dr, ok := s.turns.(interface{ DropSessionRuntime(string, string) }); ok {
		dr.DropSessionRuntime(pid, sid)
	}
	info, err = db.SessionInfoOf(ctx, sid)
	if err != nil {
		return MoveWorktreeResult{}, sessionErr(err)
	}
	view := s.turns.SessionView(ctx, db, info)
	s.hub.Publish(pid, events.WorkspaceUpdated, map[string]any{"workspace": ws})
	s.hub.Publish(pid, events.SessionUpdated, map[string]any{"session": view})
	return MoveWorktreeResult{Session: view, Workspace: ws}, nil
}

func (s *Service) createWorktreeForProject(ctx context.Context, db *projectstore.DB, folders []projectstore.Folder, branch, baseRef string, carry bool) (projectstore.Workspace, error) {
	if len(folders) == 0 {
		return projectstore.Workspace{}, of(KindConflict, usererr.WorktreeUnavailable("no folders attached to the project"))
	}
	wid := projectstore.NewID("wrk")
	type createdWT struct{ repo, path string }
	var created []createdWT
	cleanup := func() {
		for _, c := range created {
			_ = gitx.WorktreeRemove(context.Background(), c.repo, c.path)
		}
	}
	wf := make([]projectstore.WorkspaceFolder, 0, len(folders))
	gitCount := 0
	for _, f := range folders {
		if !gitx.IsRepo(ctx, f.Path) {
			wf = append(wf, projectstore.WorkspaceFolder{
				WorkspaceID: wid, FolderID: f.ID, FolderLabel: f.Label, Path: f.Path, Shared: true,
			})
			continue
		}
		repoRoot, err := gitx.TopLevel(ctx, f.Path)
		if err != nil {
			cleanup()
			return projectstore.Workspace{}, of(KindConflict, usererr.SessionWorktreeFailed(err.Error()))
		}
		gitCount++
		baseBranch, _ := gitx.HeadBranch(ctx, repoRoot)
		startPoint := strings.TrimSpace(baseRef)
		var baseCommit string
		if startPoint != "" {
			baseCommit, err = gitx.Resolve(ctx, repoRoot, startPoint)
		} else {
			baseCommit, err = gitx.HeadCommit(ctx, repoRoot)
		}
		if err != nil {
			cleanup()
			return projectstore.Workspace{}, of(KindConflict, usererr.SessionWorktreeFailed(err.Error()))
		}
		wtRoot := filepath.Join(db.Dir(), "worktrees", wid, f.Label)
		if err := gitx.WorktreeAddBranch(ctx, repoRoot, wtRoot, branch, baseCommit); err != nil {
			cleanup()
			return projectstore.Workspace{}, of(KindConflict, usererr.SessionWorktreeFailed(err.Error()))
		}
		created = append(created, createdWT{repo: repoRoot, path: wtRoot})
		if carry {
			if err := gitx.CarryWorkingTreeChanges(ctx, repoRoot, wtRoot); err != nil {
				cleanup()
				return projectstore.Workspace{}, of(KindConflict, usererr.SessionWorktreeFailed(err.Error()))
			}
		}
		folderPath := wtRoot
		if rel, err := filepath.Rel(repoRoot, f.Path); err == nil && rel != "." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && rel != ".." {
			folderPath = filepath.Join(wtRoot, rel)
		}
		wf = append(wf, projectstore.WorkspaceFolder{
			WorkspaceID: wid, FolderID: f.ID, FolderLabel: f.Label, Path: folderPath,
			RepoRoot: repoRoot, Branch: branch, BaseBranch: baseBranch, BaseCommit: baseCommit,
		})
	}
	if gitCount == 0 {
		return projectstore.Workspace{}, of(KindConflict, usererr.WorktreeUnavailable("no folder is in a git repository"))
	}
	ws, err := db.CreateWorktreeWorkspace(ctx, projectstore.Workspace{
		ID: wid, Kind: "worktree", Title: "Worktree · " + branch, State: "ready", CarryChanges: carry,
	}, wf)
	if err != nil {
		cleanup()
		var pErr *Error
		if errors.As(err, &pErr) {
			return projectstore.Workspace{}, err
		}
		return projectstore.Workspace{}, storeErr(err)
	}
	return ws, nil
}

func defaultWorktreeBranch(info projectstore.SessionInfo) string {
	slug := slugifyBranchPart(info.Title)
	short := strings.TrimPrefix(info.ID, "ses_")
	if len(short) > 6 {
		short = short[:6]
	}
	if slug == "" || slug == "new-session" {
		if short == "" {
			return "octo/worktree"
		}
		return "octo/" + short
	}
	if short != "" {
		return "octo/" + slug + "-" + short
	}
	return "octo/" + slug
}

func slugifyBranchPart(s string) string {
	var b strings.Builder
	prevDash := true
	for _, r := range strings.ToLower(strings.TrimSpace(s)) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			if r <= unicode.MaxASCII {
				b.WriteRune(r)
				prevDash = false
				if b.Len() >= 28 {
					break
				}
			}
			continue
		}
		if !prevDash && b.Len() > 0 {
			b.WriteByte('-')
			prevDash = true
		}
	}
	return strings.Trim(b.String(), "-")
}
