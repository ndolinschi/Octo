package review

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/codehost"
	"github.com/ndolinschi/Octo/apps/harness/internal/gitx"
	"github.com/ndolinschi/Octo/apps/harness/internal/projcfg"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// OpenRequest starts a review.
type OpenRequest struct {
	// Folder is the label of the project folder (default: the first git folder).
	Folder string `json:"folder,omitempty"`
	// Source is "github" or "local". Empty: "local" when Base and Head are set, else "github".
	Source string `json:"source,omitempty"`
	// PR is a pull-request number, URL a pull-request address (github).
	PR  int    `json:"pr,omitempty"`
	URL string `json:"url,omitempty"`
	// Base and Head are refs of the folder's repository (local).
	Base string `json:"base,omitempty"`
	Head string `json:"head,omitempty"`
}

var prURLRe = regexp.MustCompile(`^/([^/]+)/([^/]+)/pull/(\d+)`)

func parsePRURL(raw string) (host, owner, name string, n int, ok bool) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return "", "", "", 0, false
	}
	m := prURLRe.FindStringSubmatch(u.Path)
	if m == nil {
		return "", "", "", 0, false
	}
	n, _ = strconv.Atoi(m[3])
	return strings.ToLower(u.Host), m[1], m[2], n, n > 0
}

// View is a review with what the UI needs to draw its header.
type View struct {
	projectstore.Review
	PendingComments int    `json:"pending_comments"`
	WorktreePresent bool   `json:"worktree_present"`
	Meta            Meta   `json:"meta"`
	Totals          Totals `json:"totals"`
	FindingCount    int    `json:"findings"`
	ViewedCount     int    `json:"viewed_count"`
	LargePR         bool   `json:"large_pr"`
	// Config is the project's review configuration: commands to offer, extra mechanical
	// globs (already applied to the reading order), the preferred diff view.
	Config projcfg.ReviewConfig `json:"config"`
}

func (s *Service) view(ctx context.Context, db *projectstore.DB, r projectstore.Review) (View, error) {
	v := View{Review: r, WorktreePresent: worktreePresent(r), Config: reviewConfig(ctx, db)}
	v.PendingComments, _ = db.PendingComments(ctx, r.ID)
	_ = json.Unmarshal([]byte(r.MetaJSON), &v.Meta)
	if v.Meta.Commits == nil {
		v.Meta.Commits = []gitx.Commit{}
	}
	v.Meta.Runs = []RunRef{}
	if runs, err := db.Runs(ctx, r.ID, 20); err == nil {
		for _, run := range runs {
			v.Meta.Runs = append(v.Meta.Runs, RunRef{ID: run.ID, Name: run.Name, Status: run.Status, ExitCode: run.ExitCode,
				StartedAt: run.StartedAt, FinishedAt: run.FinishedAt})
		}
	}
	if fs, err := db.Findings(ctx, r.ID); err == nil {
		v.FindingCount = len(fs)
	}
	if files, err := s.files(ctx, db, r); err == nil {
		v.Totals = totalsOf(files)
		v.LargePR = v.Totals.Files > LargeFiles || v.Totals.Added+v.Totals.Removed > LargeLines
		marks, _ := db.Viewed(ctx, r.ID)
		for _, f := range files {
			if m, ok := marks[f.Path]; ok && m.Blob == f.Blob {
				v.ViewedCount++
			}
		}
	}
	return v, nil
}

func totalsOf(files []File) Totals {
	t := Totals{Files: len(files)}
	for _, f := range files {
		t.Added += f.Added
		t.Removed += f.Removed
		if f.Folded {
			t.Mechanical++
		}
	}
	return t
}

// Open starts a review (or returns the open one of the same source, refreshed).
// created is true when a new review was made.
func (s *Service) Open(ctx context.Context, pid string, req OpenRequest) (View, bool, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return View{}, false, err
	}
	src := strings.ToLower(req.Source)
	if src == "" {
		if req.Base != "" || req.Head != "" {
			src = "local"
		} else {
			src = "github"
		}
	}
	label, dir, err := s.folder(ctx, db, req.Folder)
	if err != nil {
		return View{}, false, err
	}
	switch src {
	case "local":
		return s.openLocal(ctx, db, pid, label, dir, req)
	case "github":
		return s.openGitHub(ctx, db, pid, label, dir, req)
	}
	return View{}, false, invalid("invalid_source", "source must be github or local")
}

func (s *Service) openLocal(ctx context.Context, db *projectstore.DB, pid, label, dir string, req OpenRequest) (View, bool, error) {
	base, head := strings.TrimSpace(req.Base), strings.TrimSpace(req.Head)
	if head == "" {
		head = "HEAD"
	}
	if base == "" {
		return View{}, false, invalid("invalid_request", "base is required for a local review")
	}
	if !gitx.ValidRefName(base) || !gitx.ValidRefName(head) {
		return View{}, false, invalid("invalid_ref", "base and head must be branch, tag or commit names")
	}
	baseC, err := gitx.Resolve(ctx, dir, base)
	if err != nil {
		return View{}, false, invalid("unknown_ref", "%v", err)
	}
	headC, err := gitx.Resolve(ctx, dir, head)
	if err != nil {
		return View{}, false, invalid("unknown_ref", "%v", err)
	}
	source := projectstore.LocalSource(base, head)
	if ex, err := db.OpenReviewBySource(ctx, source); err == nil {
		v, err := s.refresh(ctx, db, pid, ex)
		return v, false, err
	}
	mb, err := gitx.MergeBase(ctx, dir, baseC, headC)
	if err != nil {
		return View{}, false, gitErr(err)
	}
	r, err := db.CreateReview(ctx, projectstore.Review{
		Source: source, Kind: "local", Folder: label, Title: base + ".." + head,
		BaseRef: base, HeadRef: head, BaseCommit: mb, HeadCommit: headC,
	})
	if err != nil {
		return View{}, false, err
	}
	unlock := s.lock(r.ID)
	defer unlock()
	if err := s.finish(ctx, db, pid, dir, &r, nil); err != nil {
		_ = db.DeleteReview(ctx, r.ID)
		return View{}, false, err
	}
	v, err := s.view(ctx, db, r)
	s.publish(ctx, db, pid, r, "created")
	return v, true, err
}

func (s *Service) openGitHub(ctx context.Context, db *projectstore.DB, pid, label, dir string, req OpenRequest) (View, bool, error) {
	if s.host == nil {
		return View{}, false, conflict("no_host", "no code host is configured; review a local branch instead")
	}
	number := req.PR
	var urlHost, urlOwner, urlName string
	if req.URL != "" {
		h, o, n, num, ok := parsePRURL(req.URL)
		if !ok {
			return View{}, false, invalid("invalid_url", "not a pull request address (expected https://host/owner/repo/pull/N)")
		}
		urlHost, urlOwner, urlName, number = h, o, n, num
	}
	if number <= 0 {
		return View{}, false, invalid("invalid_request", "pr (a number) or url is required")
	}
	repo, err := s.host.Repo(ctx, dir)
	if err != nil {
		return View{}, false, hostErr(err)
	}
	if urlOwner != "" && (!strings.EqualFold(urlOwner, repo.Owner) || !strings.EqualFold(urlName, repo.Name)) {
		return View{}, false, invalid("repo_mismatch", "that pull request belongs to %s/%s, the folder's repository is %s", urlOwner, urlName, repo)
	}
	if urlHost != "" && repo.Host != "" && !strings.EqualFold(urlHost, repo.Host) {
		return View{}, false, invalid("repo_mismatch", "that pull request is on %s, the folder's repository is on %s", urlHost, repo.Host)
	}
	source := projectstore.GitHubSource(repo.String(), number)
	if ex, err := db.OpenReviewBySource(ctx, source); err == nil {
		v, err := s.refresh(ctx, db, pid, ex)
		return v, false, err
	}
	detail, err := s.host.View(ctx, dir, repo, number)
	if err != nil {
		return View{}, false, hostErr(err)
	}
	if detail.State != "" && detail.State != "open" {
		return View{}, false, conflict("pr_not_open", "pull request #%d is %s", number, detail.State)
	}
	r, err := db.CreateReview(ctx, projectstore.Review{
		Source: source, Kind: "github", Folder: label, Repo: repo.String(), Number: number,
		Title: detail.Title, Body: detail.Body, Author: detail.Author, URL: detail.URL,
		BaseRef: detail.BaseRef, HeadRef: detail.HeadRef,
	})
	if err != nil {
		return View{}, false, err
	}
	unlock := s.lock(r.ID)
	defer unlock()
	if err := s.fetchPR(ctx, dir, &r, detail); err != nil {
		_ = db.DeleteReview(ctx, r.ID)
		return View{}, false, err
	}
	if err := s.finish(ctx, db, pid, dir, &r, &detail); err != nil {
		_ = db.DeleteReview(ctx, r.ID)
		gitx.DeleteRefs(ctx, dir, refPrefix(r.ID))
		return View{}, false, err
	}
	v, err := s.view(ctx, db, r)
	s.publish(ctx, db, pid, r, "created")
	return v, true, err
}

// fetchPR fetches the pull request's head and its base branch into private
// refs and sets r's commits (the diff base is the merge base).
func (s *Service) fetchPR(ctx context.Context, dir string, r *projectstore.Review, d codehost.PRDetail) error {
	remote := pickRemote(ctx, dir, r.Repo)
	pre := refPrefix(r.ID)
	specs := []string{fmt.Sprintf("+refs/pull/%d/head:%shead", r.Number, pre)}
	if d.BaseRef != "" && gitx.ValidRefName(d.BaseRef) {
		specs = append(specs, fmt.Sprintf("+refs/heads/%s:%sbase", d.BaseRef, pre))
	}
	if err := gitx.Fetch(ctx, dir, remote, specs...); err != nil {
		return &Error{Kind: KindUpstream, Code: "fetch_failed", Message: gitErr(err).Error()}
	}
	head, err := gitx.Resolve(ctx, dir, pre+"head")
	if err != nil {
		return &Error{Kind: KindUpstream, Code: "fetch_failed", Message: "the pull request head was not fetched"}
	}
	base := d.BaseSHA
	if tip, err := gitx.Resolve(ctx, dir, pre+"base"); err == nil {
		base = tip
	}
	if base == "" {
		return &Error{Kind: KindUpstream, Code: "fetch_failed", Message: "the base branch was not fetched"}
	}
	mb, err := gitx.MergeBase(ctx, dir, base, head)
	if err != nil {
		return gitErr(err)
	}
	r.HeadCommit, r.BaseCommit = head, mb
	return nil
}

// pickRemote chooses the remote that points at repo ("owner/name"), else origin.
func pickRemote(ctx context.Context, dir, repo string) string {
	remotes, err := gitx.Remotes(ctx, dir)
	if err != nil || len(remotes) == 0 {
		return "origin"
	}
	want := strings.ToLower(repo)
	var names []string
	for n := range remotes {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		u := strings.ToLower(strings.TrimSuffix(strings.TrimSuffix(remotes[n], "/"), ".git"))
		if strings.HasSuffix(u, "/"+want) || strings.HasSuffix(u, ":"+want) {
			return n
		}
	}
	if _, ok := remotes["origin"]; ok {
		return "origin"
	}
	return names[0]
}

// finish records commits, makes the worktree and stores the meta. r must have
// BaseCommit and HeadCommit set.
func (s *Service) finish(ctx context.Context, db *projectstore.DB, pid, dir string, r *projectstore.Review, d *codehost.PRDetail) error {
	if err := s.ensureWorktree(ctx, db, dir, r); err != nil {
		return err
	}
	meta := s.buildMeta(ctx, dir, *r, d)
	mj, _ := json.Marshal(meta)
	m := string(mj)
	title, body := r.Title, r.Body
	cur, err := db.UpdateReview(ctx, r.ID, projectstore.ReviewPatch{
		Title: &title, Body: &body, BaseCommit: &r.BaseCommit, HeadCommit: &r.HeadCommit, WorktreePath: &r.WorktreePath,
		BaseRef: &r.BaseRef, HeadRef: &r.HeadRef, MetaJSON: &m, Touch: true,
	})
	if err != nil {
		return err
	}
	*r = cur
	s.invalidate(r.ID)
	if d != nil {
		// The code host's review threads come with the review; a failed fetch is
		// recorded (Threads says so) and never fails the open or the refresh.
		_ = s.fetchThreads(ctx, db, *r)
	}
	return nil
}

func (s *Service) buildMeta(ctx context.Context, dir string, r projectstore.Review, d *codehost.PRDetail) Meta {
	meta := Meta{Commits: []gitx.Commit{}, RefreshedAt: projectstore.Now()}
	if commits, err := gitx.Commits(ctx, dir, r.BaseCommit, r.HeadCommit, 250); err == nil && commits != nil {
		meta.Commits = commits
	}
	if d != nil {
		meta.Draft, meta.PRState, meta.Mergeable = d.Draft, d.State, d.Mergeable
		meta.ReviewDecision, meta.Labels, meta.ChecksState = d.ReviewDecision, d.Labels, d.Checks
		meta.Conversation, meta.BodyTruncated = d.Conversation, d.BodyCut
		if s.host != nil {
			if repo, ok := parseRepo(r.Repo); ok {
				if checks, err := s.host.Checks(ctx, dir, repo, r.Number); err == nil {
					meta.Checks = checks
				}
			}
		}
	}
	return meta
}

// ensureWorktree makes sure the review's worktree exists at its head commit.
func (s *Service) ensureWorktree(ctx context.Context, db *projectstore.DB, dir string, r *projectstore.Review) error {
	path := r.WorktreePath
	if path == "" {
		path = s.worktreeDir(db, r.ID)
	}
	if worktreePresent(projectstore.Review{WorktreePath: path}) {
		cur, err := gitx.Run(ctx, path, "rev-parse", "HEAD")
		if err == nil && strings.TrimSpace(string(cur)) == r.HeadCommit {
			r.WorktreePath = path
			return nil
		}
		if err := gitx.WorktreeCheckout(ctx, path, r.HeadCommit); err != nil {
			return &Error{Kind: KindUpstream, Code: "worktree_failed", Message: gitErr(err).Error()}
		}
		r.WorktreePath = path
		return nil
	}
	// A leftover directory or a stale registration from an earlier run.
	_, _ = gitx.Run(ctx, dir, "worktree", "prune")
	if err := gitx.WorktreeAdd(ctx, dir, path, r.HeadCommit); err != nil {
		return &Error{Kind: KindUpstream, Code: "worktree_failed", Message: gitErr(err).Error()}
	}
	r.WorktreePath = path
	return nil
}

// Get returns one review.
func (s *Service) Get(ctx context.Context, pid, rid string) (View, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return View{}, err
	}
	r, err := s.review(ctx, db, rid)
	if err != nil {
		return View{}, err
	}
	_ = db.TouchReview(ctx, rid)
	return s.view(ctx, db, r)
}

// List returns the project's reviews, most recently used first; state "" = all.
func (s *Service) List(ctx context.Context, pid, state string) ([]Summary, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return nil, err
	}
	if state != "" && state != projectstore.ReviewOpen && state != projectstore.ReviewClosed {
		return nil, invalid("invalid_request", "state must be open or closed")
	}
	list, err := db.Reviews(ctx, state)
	if err != nil {
		return nil, err
	}
	out := make([]Summary, 0, len(list))
	for _, r := range list {
		out = append(out, s.summary(ctx, db, r))
	}
	return out, nil
}

// PatchRequest changes a review. Refresh re-fetches the head (and checks);
// State closes or reopens it.
type PatchRequest struct {
	State   *string `json:"state,omitempty"`
	Refresh bool    `json:"refresh,omitempty"`
}

// Patch applies a PatchRequest.
func (s *Service) Patch(ctx context.Context, pid, rid string, p PatchRequest) (View, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return View{}, err
	}
	r, err := s.review(ctx, db, rid)
	if err != nil {
		return View{}, err
	}
	if p.State != nil && *p.State != projectstore.ReviewOpen && *p.State != projectstore.ReviewClosed {
		return View{}, invalid("invalid_request", "state must be open or closed")
	}
	if p.State != nil && *p.State == projectstore.ReviewClosed && r.State != projectstore.ReviewClosed {
		unlock := s.lock(rid)
		cur, err := db.UpdateReview(ctx, rid, projectstore.ReviewPatch{State: p.State, Touch: true})
		unlock()
		if err != nil {
			return View{}, err
		}
		s.publish(ctx, db, pid, cur, "closed")
		// Pending comments keep the worktree; Sweep decides.
		_ = s.Sweep(ctx, pid)
		return s.Get(ctx, pid, rid)
	}
	if (p.State != nil && *p.State == projectstore.ReviewOpen && r.State == projectstore.ReviewClosed) || p.Refresh {
		if p.State != nil && *p.State == projectstore.ReviewOpen && r.State == projectstore.ReviewClosed {
			open := projectstore.ReviewOpen
			if r, err = db.UpdateReview(ctx, rid, projectstore.ReviewPatch{State: &open, Touch: true}); err != nil {
				return View{}, err
			}
		}
		return s.refresh(ctx, db, pid, r)
	}
	return s.Get(ctx, pid, rid)
}

// refresh re-reads the source: a pull request's new head, a local branch's new
// tip. Viewed marks stay (they compare file contents); the worktree moves.
func (s *Service) refresh(ctx context.Context, db *projectstore.DB, pid string, r projectstore.Review) (View, error) {
	unlock := s.lock(r.ID)
	defer unlock()
	_, dir, err := s.folder(ctx, db, r.Folder)
	if err != nil {
		return View{}, err
	}
	var detail *codehost.PRDetail
	switch r.Kind {
	case "github":
		if s.host == nil {
			return View{}, conflict("no_host", "no code host is configured")
		}
		repo, ok := parseRepo(r.Repo)
		if !ok {
			return View{}, conflict("invalid_review", "review has no repository")
		}
		d, err := s.host.View(ctx, dir, repo, r.Number)
		if err != nil {
			return View{}, hostErr(err)
		}
		detail = &d
		if err := s.fetchPR(ctx, dir, &r, d); err != nil {
			return View{}, err
		}
		r.Title, r.Body, r.Author = d.Title, d.Body, d.Author
		r.BaseRef, r.HeadRef = d.BaseRef, d.HeadRef
		if d.State != "" && d.State != "open" {
			closed := projectstore.ReviewClosed
			r.State = closed
		}
	case "local":
		baseC, err := gitx.Resolve(ctx, dir, r.BaseRef)
		if err != nil {
			return View{}, invalid("unknown_ref", "%v", err)
		}
		headC, err := gitx.Resolve(ctx, dir, r.HeadRef)
		if err != nil {
			return View{}, invalid("unknown_ref", "%v", err)
		}
		mb, err := gitx.MergeBase(ctx, dir, baseC, headC)
		if err != nil {
			return View{}, gitErr(err)
		}
		r.BaseCommit, r.HeadCommit = mb, headC
	}
	if err := s.finish(ctx, db, pid, dir, &r, detail); err != nil {
		return View{}, err
	}
	if r.State == projectstore.ReviewClosed {
		st := projectstore.ReviewClosed
		if cur, err := db.UpdateReview(ctx, r.ID, projectstore.ReviewPatch{State: &st}); err == nil {
			r = cur
		}
	}
	s.publish(ctx, db, pid, r, "refreshed")
	return s.view(ctx, db, r)
}
