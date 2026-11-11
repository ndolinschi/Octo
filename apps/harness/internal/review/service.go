// Package review is the pull-request review feature of the harness (RV1): a
// code-host adapter, local-branch sources, git worktrees under the project's
// data directory, the review store with viewed marks, findings and pending
// comments, the diff API with its reading order, and submit.
//
// Safety rules, enforced here and tested:
//
//   - Nothing is written to a code host except by Service.Submit, which only an
//     explicit HTTP call reaches. No agent tool, no MCP tool and no other code
//     path of the harness imports this package.
//   - Text that comes from a pull request (title, description, comments, branch
//     names) is untrusted data. It is stored and returned as strings; nothing in
//     this package feeds it to a model, a shell or a permission decision.
//   - The user's working tree is never touched: reviews live in worktrees under
//     {data-dir}/projects/{pid}/review/.
package review

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/codehost"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/gitx"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// EventUpdated is the project event the service publishes when a review
// changes. Payload: { review_id, reason, review: Summary }.
const EventUpdated = "review.updated"

// WorktreeRetention is how long an unused review keeps its worktree.
const WorktreeRetention = 14 * 24 * time.Hour

// Kind classifies an Error for the HTTP layer.
type Kind int

const (
	KindInvalid Kind = iota + 1
	KindNotFound
	KindConflict
	KindTooLarge
	KindUpstream
	KindUnsupported
)

// Error is a caller-visible failure with a stable machine code.
type Error struct {
	Kind    Kind
	Code    string
	Message string
	// Command is what the user can run to fix an unavailable code host.
	Command string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func invalid(code, format string, args ...any) *Error {
	return &Error{Kind: KindInvalid, Code: code, Message: fmt.Sprintf(format, args...)}
}
func notFound(what string) *Error {
	return &Error{Kind: KindNotFound, Code: "not_found", Message: what + " not found"}
}
func conflict(code, format string, args ...any) *Error {
	return &Error{Kind: KindConflict, Code: code, Message: fmt.Sprintf(format, args...)}
}

// hostErr maps a code-host failure.
func hostErr(err error) error {
	if u, ok := codehost.IsUnavailable(err); ok {
		return &Error{Kind: KindConflict, Code: u.Reason, Message: u.Message, Command: u.Command}
	}
	var he *codehost.Error
	if errors.As(err, &he) {
		return &Error{Kind: KindUpstream, Code: "code_host_error", Message: he.Error()}
	}
	return err
}

func gitErr(err error) error {
	if errors.Is(err, gitx.ErrNoGit) {
		return &Error{Kind: KindConflict, Code: "git_not_installed", Message: err.Error()}
	}
	var ge *gitx.Error
	if errors.As(err, &ge) {
		return &Error{Kind: KindUpstream, Code: "git_error", Message: ge.Error()}
	}
	return err
}

// Service is the review application layer of every project.
type Service struct {
	store *projectstore.Store
	hub   *events.Hub
	host  codehost.Host
	now   func() time.Time

	mu    sync.Mutex
	locks map[string]*sync.Mutex
	cache map[string]cachedFiles
}

type cachedFiles struct {
	key   string
	files []File
}

// Options configure New.
type Options struct {
	// Host is the code-host adapter (nil: only local-branch reviews work).
	Host codehost.Host
	// Now overrides the clock (tests).
	Now func() time.Time
}

// New returns the service.
func New(store *projectstore.Store, hub *events.Hub, o Options) *Service {
	s := &Service{store: store, hub: hub, host: o.Host, now: o.Now, locks: map[string]*sync.Mutex{}, cache: map[string]cachedFiles{}}
	if s.now == nil {
		s.now = time.Now
	}
	return s
}

func (s *Service) lock(rid string) func() {
	s.mu.Lock()
	l, ok := s.locks[rid]
	if !ok {
		l = &sync.Mutex{}
		s.locks[rid] = l
	}
	s.mu.Unlock()
	l.Lock()
	return l.Unlock
}

func (s *Service) db(ctx context.Context, pid string) (*projectstore.DB, error) {
	db, err := s.store.Get(ctx, pid)
	if errors.Is(err, projectstore.ErrNotFound) {
		return nil, notFound("project")
	}
	var ne *projectstore.NewerSchemaError
	if errors.As(err, &ne) {
		return nil, &Error{Kind: KindConflict, Code: "newer_schema", Message: ne.Error()}
	}
	return db, err
}

func (s *Service) review(ctx context.Context, db *projectstore.DB, rid string) (projectstore.Review, error) {
	r, err := db.Review(ctx, rid)
	if errors.Is(err, projectstore.ErrNotFound) {
		return r, notFound("review")
	}
	return r, err
}

// folder resolves a project folder to its path. An empty label picks the first
// folder that is a git work tree.
func (s *Service) folder(ctx context.Context, db *projectstore.DB, label string) (string, string, error) {
	folders, err := db.Folders(ctx)
	if err != nil {
		return "", "", err
	}
	if len(folders) == 0 {
		return "", "", conflict("no_folder", "the project has no folder; add the repository to review")
	}
	if label != "" {
		for _, f := range folders {
			if f.Label == label {
				if !gitx.IsRepo(ctx, f.Path) {
					return "", "", conflict("not_a_git_repo", "folder %q is not a git repository", label)
				}
				return f.Label, f.Path, nil
			}
		}
		return "", "", invalid("unknown_folder", "the project has no folder %q", label)
	}
	for _, f := range folders {
		if gitx.IsRepo(ctx, f.Path) {
			return f.Label, f.Path, nil
		}
	}
	return "", "", conflict("not_a_git_repo", "none of the project's folders is a git repository")
}

// Summary is the short form carried by events and lists.
type Summary struct {
	ID                string `json:"id"`
	Source            string `json:"source"`
	Kind              string `json:"kind"`
	Title             string `json:"title"`
	State             string `json:"state"`
	HeadCommit        string `json:"head_commit"`
	LastSubmittedHead string `json:"last_submitted_head,omitempty"`
	PendingComments   int    `json:"pending_comments"`
	UpdatedAt         string `json:"updated_at"`
	LastUsedAt        string `json:"last_used_at"`
}

func (s *Service) summary(ctx context.Context, db *projectstore.DB, r projectstore.Review) Summary {
	n, _ := db.PendingComments(ctx, r.ID)
	return Summary{ID: r.ID, Source: r.Source, Kind: r.Kind, Title: r.Title, State: r.State, HeadCommit: r.HeadCommit,
		LastSubmittedHead: r.LastSubmittedHead, PendingComments: n, UpdatedAt: r.UpdatedAt, LastUsedAt: r.LastUsedAt}
}

func (s *Service) publish(ctx context.Context, db *projectstore.DB, pid string, r projectstore.Review, reason string) {
	if s.hub == nil {
		return
	}
	s.hub.Publish(pid, EventUpdated, map[string]any{"review_id": r.ID, "reason": reason, "review": s.summary(ctx, db, r)})
}

// Meta is what is kept of the host's view of a pull request (all of it
// untrusted text, shown as data).
type Meta struct {
	Draft          bool                    `json:"draft,omitempty"`
	PRState        string                  `json:"pr_state,omitempty"`
	Mergeable      string                  `json:"mergeable,omitempty"`
	ReviewDecision string                  `json:"review_decision,omitempty"`
	Labels         []string                `json:"labels,omitempty"`
	ChecksState    string                  `json:"checks_state,omitempty"`
	Checks         []codehost.Check        `json:"checks,omitempty"`
	Commits        []gitx.Commit           `json:"commits"`
	Conversation   []codehost.Conversation `json:"conversation,omitempty"`
	BodyTruncated  bool                    `json:"body_truncated,omitempty"`
	RefreshedAt    string                  `json:"refreshed_at,omitempty"`
}

// removeWorktree deletes a review's worktree and its pinning refs.
func (s *Service) removeWorktree(ctx context.Context, db *projectstore.DB, r projectstore.Review) error {
	if r.WorktreePath == "" {
		return nil
	}
	_, repo, err := s.folder(ctx, db, r.Folder)
	if err == nil {
		if rmErr := gitx.WorktreeRemove(ctx, repo, r.WorktreePath); rmErr != nil {
			return rmErr
		}
		gitx.DeleteRefs(ctx, repo, refPrefix(r.ID))
	} else if rmErr := os.RemoveAll(r.WorktreePath); rmErr != nil {
		return rmErr
	}
	empty := ""
	_, err = db.UpdateReview(ctx, r.ID, projectstore.ReviewPatch{WorktreePath: &empty})
	return err
}

func refPrefix(rid string) string { return "refs/octo/review/" + rid + "/" }

func (s *Service) worktreeDir(db *projectstore.DB, rid string) string {
	return filepath.Join(db.Dir(), "review", rid)
}

func worktreePresent(r projectstore.Review) bool {
	if r.WorktreePath == "" {
		return false
	}
	fi, err := os.Stat(r.WorktreePath)
	return err == nil && fi.IsDir()
}

// Sweep removes the worktrees that are no longer needed: those of closed
// reviews and of reviews unused for WorktreeRetention. A review with pending
// comments keeps its worktree whatever its state or age.
func (s *Service) Sweep(ctx context.Context, pid string) error {
	db, err := s.db(ctx, pid)
	if err != nil {
		return err
	}
	list, err := db.Reviews(ctx, "")
	if err != nil {
		return err
	}
	cutoff := s.now().Add(-WorktreeRetention)
	for _, r := range list {
		if r.WorktreePath == "" {
			continue
		}
		if n, err := db.PendingComments(ctx, r.ID); err != nil || n > 0 {
			continue
		}
		stale := false
		if t, err := time.Parse(time.RFC3339Nano, r.LastUsedAt); err == nil && t.Before(cutoff) {
			stale = true
		}
		if r.State != projectstore.ReviewClosed && !stale {
			continue
		}
		unlock := s.lock(r.ID)
		err := s.removeWorktree(ctx, db, r)
		unlock()
		if err != nil {
			continue
		}
		if cur, err := db.Review(ctx, r.ID); err == nil {
			s.publish(ctx, db, pid, cur, "worktree_removed")
		}
	}
	return nil
}

// SweepAll runs Sweep for every project (start-up and a timer).
func (s *Service) SweepAll(ctx context.Context) {
	ids, err := s.store.IDs(ctx)
	if err != nil {
		return
	}
	for _, id := range ids {
		if ctx.Err() != nil {
			return
		}
		_ = s.Sweep(ctx, id)
	}
}

// Run sweeps every project now and then every interval until ctx ends.
func (s *Service) Run(ctx context.Context, interval time.Duration) {
	s.SweepAll(ctx)
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.SweepAll(ctx)
		}
	}
}

func parseRepo(s string) (codehost.Repo, bool) {
	o, n, ok := strings.Cut(s, "/")
	if !ok || o == "" || n == "" {
		return codehost.Repo{}, false
	}
	return codehost.Repo{Owner: o, Name: n}, true
}
