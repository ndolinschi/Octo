package review

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/gitx"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// EventWorkspace is the project event the service publishes when the active
// review workspace is set or cleared. Payload: { review_workspace } (null when cleared).
const EventWorkspace = "review.workspace"

// Checkout modes.
const (
	ModeWorkspace   = "workspace"
	ModeWorkingCopy = "working_copy"
)

// CheckoutRequest asks to check a pull request out.
type CheckoutRequest struct {
	// Mode is "workspace" (point the project's file tree, editor, search and language
	// server at the review's worktree) or "working_copy" (switch the project's own
	// folder to a local branch of the pull request).
	Mode string `json:"mode"`
	// Confirm accepts uncommitted changes in the working copy (they are carried over by
	// git, never discarded, never forced).
	Confirm bool `json:"confirm,omitempty"`
}

// CheckoutResult is the outcome of a checkout.
type CheckoutResult struct {
	Mode string `json:"mode"`
	// Workspace is set for mode workspace: the project's active review workspace now.
	Workspace *projectstore.ReviewWorkspace `json:"workspace,omitempty"`
	// The rest is set for mode working_copy.
	Folder string `json:"folder,omitempty"`
	Branch string `json:"branch,omitempty"`
	// PreviousBranch is the branch the folder was on ("" when detached).
	PreviousBranch string `json:"previous_branch,omitempty"`
	// Commit is the pull request's head the branch is at now.
	Commit string `json:"commit,omitempty"`
	// Created: the branch did not exist. AlreadyOnBranch: the folder was on it already.
	// FastForwarded: an existing branch was moved forward to the pull request's newer head.
	Created         bool `json:"created,omitempty"`
	AlreadyOnBranch bool `json:"already_on_branch,omitempty"`
	FastForwarded   bool `json:"fast_forwarded,omitempty"`
}

// DirtyFile is an uncommitted change of a working copy.
type DirtyFile struct {
	Path string `json:"path"`
	// Status is modified, added, deleted, renamed, copied, untracked or conflicted; Code is git's two-letter status.
	Status string `json:"status"`
	Code   string `json:"code"`
}

func dirtyStatus(code string) string {
	x, y := code[0], code[1]
	switch {
	case code == "??":
		return "untracked"
	case x == 'U' || y == 'U' || code == "AA" || code == "DD":
		return "conflicted"
	case x == 'R' || y == 'R':
		return "renamed"
	case x == 'C' || y == 'C':
		return "copied"
	case x == 'A' || y == 'A':
		return "added"
	case x == 'D' || y == 'D':
		return "deleted"
	}
	return "modified"
}

// workingCopyChanges lists the uncommitted changes of dir (tracked changes and untracked files).
func workingCopyChanges(ctx context.Context, dir string) ([]DirtyFile, error) {
	out, err := gitx.Run(ctx, dir, "status", "--porcelain=v1", "-z", "--untracked-files=normal")
	if err != nil {
		return nil, err
	}
	parts := strings.Split(string(out), "\x00")
	files := []DirtyFile{}
	for i := 0; i < len(parts); i++ {
		e := parts[i]
		if len(e) < 4 {
			continue
		}
		code, path := e[:2], e[3:]
		if code[0] == 'R' || code[0] == 'C' || code[1] == 'R' || code[1] == 'C' {
			i++ // the next field is the original path
		}
		files = append(files, DirtyFile{Path: path, Status: dirtyStatus(code), Code: code})
	}
	return files, nil
}

var nonSlug = regexp.MustCompile(`[^a-z0-9]+`)

// BranchName is the local branch a pull request is checked out to:
// review/<number>-<slug of the title>.
func BranchName(number int, title string) string {
	slug := strings.Trim(nonSlug.ReplaceAllString(strings.ToLower(title), "-"), "-")
	if len(slug) > 40 {
		slug = strings.Trim(slug[:40], "-")
	}
	if slug == "" {
		slug = "pr"
	}
	return fmt.Sprintf("review/%d-%s", number, slug)
}

// Checkout checks a pull request out, one of two ways (see CheckoutRequest).
func (s *Service) Checkout(ctx context.Context, pid, rid string, req CheckoutRequest) (CheckoutResult, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return CheckoutResult{}, err
	}
	r, err := s.review(ctx, db, rid)
	if err != nil {
		return CheckoutResult{}, err
	}
	switch req.Mode {
	case ModeWorkspace:
		return s.checkoutWorkspace(ctx, db, pid, r)
	case ModeWorkingCopy:
		return s.checkoutWorkingCopy(ctx, db, pid, r, req.Confirm)
	}
	return CheckoutResult{}, invalid("invalid_mode", "mode must be workspace or working_copy")
}

func (s *Service) checkoutWorkspace(ctx context.Context, db *projectstore.DB, pid string, r projectstore.Review) (CheckoutResult, error) {
	if r.State == projectstore.ReviewClosed {
		return CheckoutResult{}, conflict("review_closed", "the review is closed; reopen it to open it in the workspace")
	}
	if !worktreePresent(r) {
		// The worktree was swept: fetch again and make it.
		if _, err := s.refresh(ctx, db, pid, r); err != nil {
			return CheckoutResult{}, err
		}
		cur, err := s.review(ctx, db, r.ID)
		if err != nil {
			return CheckoutResult{}, err
		}
		r = cur
		if !worktreePresent(r) {
			return CheckoutResult{}, &Error{Kind: KindUpstream, Code: "worktree_failed", Message: "the review's worktree could not be made"}
		}
	}
	ws := projectstore.ReviewWorkspace{ReviewID: r.ID, Path: r.WorktreePath, Title: r.Title}
	if err := db.SetReviewWorkspace(ctx, ws); err != nil {
		return CheckoutResult{}, err
	}
	_ = db.TouchReview(ctx, r.ID)
	s.publishWorkspace(pid, &ws)
	return CheckoutResult{Mode: ModeWorkspace, Workspace: &ws}, nil
}

func (s *Service) publishWorkspace(pid string, ws *projectstore.ReviewWorkspace) {
	if s.hub != nil {
		s.hub.Publish(pid, EventWorkspace, map[string]any{"review_workspace": ws})
	}
}

// Workspace returns the project's active review workspace (nil when none).
func (s *Service) Workspace(ctx context.Context, pid string) (*projectstore.ReviewWorkspace, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return nil, err
	}
	return db.ReviewWorkspace(ctx)
}

// ClearWorkspace points the project back at its own folders. It is a no-op when none is active.
func (s *Service) ClearWorkspace(ctx context.Context, pid string) error {
	db, err := s.db(ctx, pid)
	if err != nil {
		return err
	}
	ws, err := db.ReviewWorkspace(ctx)
	if err != nil || ws == nil {
		return err
	}
	if err := db.ClearReviewWorkspace(ctx); err != nil {
		return err
	}
	s.publishWorkspace(pid, nil)
	return nil
}

// clearWorkspaceOf clears the workspace when it is review rid's (its worktree is going away).
func (s *Service) clearWorkspaceOf(ctx context.Context, db *projectstore.DB, rid string) {
	if ws, err := db.ReviewWorkspace(ctx); err == nil && ws != nil && ws.ReviewID == rid {
		if db.ClearReviewWorkspace(ctx) == nil {
			s.publishWorkspace(db.ID(), nil)
		}
	}
}

func (s *Service) checkoutWorkingCopy(ctx context.Context, db *projectstore.DB, pid string, r projectstore.Review, confirm bool) (CheckoutResult, error) {
	if r.Kind != "github" || r.Number <= 0 {
		return CheckoutResult{}, invalid("not_a_pull_request", "only a pull request can be checked out into the working copy")
	}
	unlock := s.lock(r.ID)
	defer unlock()
	label, dir, err := s.folder(ctx, db, r.Folder)
	if err != nil {
		return CheckoutResult{}, err
	}
	branch := BranchName(r.Number, r.Title)
	if !gitx.ValidRefName(branch) {
		branch = BranchName(r.Number, "")
	}
	res := CheckoutResult{Mode: ModeWorkingCopy, Folder: label, Branch: branch}

	// Look first, change nothing: where the folder is and what is uncommitted in it.
	prev := ""
	if out, err := gitx.Run(ctx, dir, "symbolic-ref", "--short", "-q", "HEAD"); err == nil {
		prev = strings.TrimSpace(string(out))
	}
	res.PreviousBranch = prev
	dirty, err := workingCopyChanges(ctx, dir)
	if err != nil {
		return CheckoutResult{}, gitErr(err)
	}
	if len(dirty) > 0 && !confirm {
		return CheckoutResult{}, &Error{Kind: KindConflict, Code: "dirty_working_copy", Files: dirty,
			Message: fmt.Sprintf("%d uncommitted change(s) in the working copy; confirm to carry them over to the new branch (nothing is discarded)", len(dirty))}
	}
	if prev == "" && !confirm {
		// A detached HEAD that no branch or tag contains would be left behind by the switch.
		if out, err := gitx.Run(ctx, dir, "for-each-ref", "--contains", "HEAD", "--count=1", "--format=%(refname)", "refs/heads", "refs/remotes", "refs/tags"); err == nil && strings.TrimSpace(string(out)) == "" {
			return CheckoutResult{}, conflict("detached_head", "the working copy is on a detached HEAD with commits no branch contains; confirm to leave it (they stay reachable through the reflog only)")
		}
	}

	// The pull request's head, fetched into a private ref (the review's own refs stay as they are).
	ref := refPrefix(r.ID) + "checkout"
	if err := gitx.Fetch(ctx, dir, pickRemote(ctx, dir, r.Repo), fmt.Sprintf("+refs/pull/%d/head:%s", r.Number, ref)); err != nil {
		return CheckoutResult{}, &Error{Kind: KindUpstream, Code: "fetch_failed", Message: gitErr(err).Error()}
	}
	commit, err := gitx.Resolve(ctx, dir, ref)
	if err != nil {
		return CheckoutResult{}, &Error{Kind: KindUpstream, Code: "fetch_failed", Message: "the pull request head was not fetched"}
	}
	res.Commit = commit

	tip := ""
	if t, err := gitx.Resolve(ctx, dir, "refs/heads/"+branch); err == nil {
		tip = t
	}
	switch {
	case tip == "":
		if _, err := gitx.Run(ctx, dir, "switch", "--create", branch, "--end-of-options", commit); err != nil {
			return CheckoutResult{}, checkoutErr(err)
		}
		res.Created = true
	case tip == commit:
		res.AlreadyOnBranch = prev == branch
		if prev != branch {
			if _, err := gitx.Run(ctx, dir, "switch", "--end-of-options", branch); err != nil {
				return CheckoutResult{}, checkoutErr(err)
			}
		}
	case gitx.IsAncestor(ctx, dir, tip, commit):
		if prev != branch {
			if _, err := gitx.Run(ctx, dir, "switch", "--end-of-options", branch); err != nil {
				return CheckoutResult{}, checkoutErr(err)
			}
		} else {
			res.AlreadyOnBranch = true
		}
		if _, err := gitx.Run(ctx, dir, "merge", "--ff-only", "--quiet", "--end-of-options", commit); err != nil {
			return CheckoutResult{}, checkoutErr(err)
		}
		res.FastForwarded = true
	default:
		return CheckoutResult{}, conflict("branch_diverged", "the local branch %s has commits the pull request does not; it was left as it is", branch)
	}
	_ = db.TouchReview(ctx, r.ID)
	s.publish(ctx, db, pid, r, "checked_out")
	return res, nil
}

// checkoutErr maps a refused git switch or merge: uncommitted changes that
// conflict with the branch are the user's to resolve, nothing is forced.
func checkoutErr(err error) error {
	msg := err.Error()
	l := strings.ToLower(msg)
	if strings.Contains(l, "would be overwritten") || strings.Contains(l, "local changes") || strings.Contains(l, "untracked working tree files") {
		return &Error{Kind: KindConflict, Code: "checkout_conflict",
			Message: "uncommitted changes conflict with the pull request's branch; commit or stash them first (nothing was changed): " + msg}
	}
	return gitErr(err)
}
