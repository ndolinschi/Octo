package review_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/codehost"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/review"
	"github.com/ndolinschi/Octo/apps/harness/internal/review/reviewtest"
)

type fixture struct {
	t    *testing.T
	repo *reviewtest.Repo
	gh   *reviewtest.Fake
	svc  *review.Service
	hub  *events.Hub
	pid  string
	db   *projectstore.DB
	now  time.Time
	data string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	repo := reviewtest.NewRepo(t)
	gh := reviewtest.NewFakeGH(t, repo)
	data := t.TempDir()
	store, err := projectstore.Open(data)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	db, err := store.Create(context.Background(), projectstore.NewProject{
		Name: "p", ModelsJSON: "{}", MaxDepth: 1, OrchestratorModel: "m",
		Folders: []projectstore.Folder{{Label: "repo", Path: repo.Dir}},
	})
	if err != nil {
		t.Fatal(err)
	}
	f := &fixture{t: t, repo: repo, gh: gh, hub: events.NewHub(), pid: db.ID(), db: db, now: time.Now(), data: data}
	f.svc = review.New(store, f.hub, review.Options{Host: codehost.NewGH(), Now: func() time.Time { return f.now }})
	return f
}

func (f *fixture) openPR(n int) review.View {
	f.t.Helper()
	v, _, err := f.svc.Open(context.Background(), f.pid, review.OpenRequest{PR: n})
	if err != nil {
		f.t.Fatalf("open PR %d: %v", n, err)
	}
	return v
}

func (f *fixture) files(rid string) review.Files {
	f.t.Helper()
	out, err := f.svc.Files(context.Background(), f.pid, rid)
	if err != nil {
		f.t.Fatal(err)
	}
	return out
}

func byPath(files []review.File, p string) review.File {
	for _, f := range files {
		if f.Path == p {
			return f
		}
	}
	return review.File{Path: "MISSING:" + p}
}

func TestListPRsPutsReviewRequestedFirstAndTiesReviews(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	list, err := f.svc.ListPRs(ctx, f.pid, "")
	if err != nil || !list.Available || list.Repo != "acme/widgets" || len(list.PRs) != 2 {
		t.Fatalf("list = %+v %v", list, err)
	}
	if list.PRs[0].Number != 2 || !list.PRs[0].ReviewRequested || list.PRs[1].Number != 1 || list.PRs[1].ReviewRequested {
		t.Fatalf("order = %d, %d", list.PRs[0].Number, list.PRs[1].Number)
	}
	if list.PRs[1].Checks != "success" || list.PRs[1].Author != "alice" || list.PRs[1].Review != nil {
		t.Fatalf("row = %+v", list.PRs[1])
	}
	v := f.openPR(1)
	list, _ = f.svc.ListPRs(ctx, f.pid, "")
	row := list.PRs[1]
	if row.Review == nil || row.Review.ID != v.ID || row.Review.NewCommits {
		t.Fatalf("review link = %+v", row.Review)
	}
	// New commits on the pull request are reported in the list.
	f.repo.AddCommit(t, "src/extra.go", "package auth\n")
	f.gh = reviewtest.NewFakeGH(t, f.repo)
	list, _ = f.svc.ListPRs(ctx, f.pid, "")
	if r := list.PRs[1].Review; r == nil || !r.NewCommits {
		t.Fatalf("new commits not reported: %+v", list.PRs[1].Review)
	}
}

func TestListPRsSaysWhyAndWhatToRun(t *testing.T) {
	f := newFixture(t)
	f.gh.LoggedOut(t, true)
	list, err := f.svc.ListPRs(context.Background(), f.pid, "")
	if err != nil || list.Available || list.Reason != "not_logged_in" || list.Command != "gh auth login" || len(list.PRs) != 0 {
		t.Fatalf("logged out = %+v %v", list, err)
	}
	// No gh at all.
	t.Setenv("PATH", t.TempDir())
	list, err = f.svc.ListPRs(context.Background(), f.pid, "")
	if err != nil || list.Available || list.Reason != "gh_not_installed" || list.Command == "" {
		t.Fatalf("no gh = %+v %v", list, err)
	}
	// A local review still works without gh.
	v, created, err := f.svc.Open(context.Background(), f.pid, review.OpenRequest{Base: "main", Head: "feature"})
	if err != nil || !created || v.Kind != "local" {
		t.Fatalf("local review = %+v %v %v", v, created, err)
	}
}

func TestOpenGitHubReviewMakesAWorktreeAndLeavesTheWorkingTreeAlone(t *testing.T) {
	f := newFixture(t)
	before := reviewtest.Git(t, f.repo.Dir, "status", "--porcelain")
	branch := reviewtest.Git(t, f.repo.Dir, "rev-parse", "--abbrev-ref", "HEAD")
	v := f.openPR(1)
	if v.Source != "github:acme/widgets#1" || v.Kind != "github" || v.State != "open" || v.Title != "Add token validation" || v.Author != "alice" {
		t.Fatalf("review = %+v", v)
	}
	if v.HeadCommit != f.repo.Head || v.BaseCommit != f.repo.Base {
		t.Fatalf("commits = %s %s, want %s %s", v.BaseCommit, v.HeadCommit, f.repo.Base, f.repo.Head)
	}
	wantDir := filepath.Join(f.db.Dir(), "review")
	if !strings.HasPrefix(v.WorktreePath, wantDir) || !v.WorktreePresent {
		t.Fatalf("worktree = %q present=%v, want under %s", v.WorktreePath, v.WorktreePresent, wantDir)
	}
	if b, err := os.ReadFile(filepath.Join(v.WorktreePath, "src", "auth.go")); err != nil || !strings.Contains(string(b), "ValidateToken") {
		t.Fatalf("worktree content: %v", err)
	}
	if head := reviewtest.Git(t, v.WorktreePath, "rev-parse", "HEAD"); head != f.repo.Head {
		t.Fatalf("worktree HEAD = %s", head)
	}
	// The user's working tree: same status, same branch, the dirty file intact.
	if got := reviewtest.Git(t, f.repo.Dir, "status", "--porcelain"); got != before {
		t.Fatalf("status changed:\n%s\nvs\n%s", got, before)
	}
	if got := reviewtest.Git(t, f.repo.Dir, "rev-parse", "--abbrev-ref", "HEAD"); got != branch {
		t.Fatalf("branch changed to %s", got)
	}
	if b, _ := os.ReadFile(f.repo.Dirty); string(b) != "uncommitted work\n" {
		t.Fatalf("dirty file = %q", b)
	}
	if len(v.Meta.Commits) != 1 || v.Meta.Commits[0].Subject != "Add token validation" || len(v.Meta.Checks) != 1 || v.Meta.ChecksState != "success" {
		t.Fatalf("meta = %+v", v.Meta)
	}
	if len(v.Meta.Conversation) != 1 || v.Meta.Conversation[0].Body != "looks fine" {
		t.Fatalf("conversation = %+v", v.Meta.Conversation)
	}
	// Opening the same pull request again returns the same review.
	v2, created, err := f.svc.Open(context.Background(), f.pid, review.OpenRequest{URL: "https://github.com/acme/widgets/pull/1"})
	if err != nil || created || v2.ID != v.ID {
		t.Fatalf("reopen = %+v %v %v", v2.ID, created, err)
	}
	// A URL of another repository is refused.
	_, _, err = f.svc.Open(context.Background(), f.pid, review.OpenRequest{URL: "https://github.com/other/repo/pull/1"})
	var re *review.Error
	if !errors.As(err, &re) || re.Code != "repo_mismatch" {
		t.Fatalf("mismatch err = %v", err)
	}
}

func TestReadingOrderGroupsAndMarkers(t *testing.T) {
	f := newFixture(t)
	v := f.openPR(1)
	files := f.files(v.ID)
	var order []string
	for _, x := range files.Files {
		order = append(order, x.Group+":"+x.Path)
		if x.Order != len(order)-1 {
			t.Fatalf("order index of %s = %d", x.Path, x.Order)
		}
	}
	// Groups appear in reading order: core, callers, tests, other, mechanical.
	rank := map[string]int{"core": 0, "callers": 1, "tests": 2, "other": 3, "mechanical": 4}
	for i := 1; i < len(files.Files); i++ {
		if rank[files.Files[i].Group] < rank[files.Files[i-1].Group] {
			t.Fatalf("groups out of order: %v", order)
		}
	}
	auth, sess := byPath(files.Files, "src/auth.go"), byPath(files.Files, "src/session.go")
	if auth.Group != "core" || sess.Group != "callers" || auth.Order >= sess.Order {
		t.Fatalf("core/callers: auth=%s/%d session=%s/%d\n%v", auth.Group, auth.Order, sess.Group, sess.Order, order)
	}
	if g := byPath(files.Files, "src/auth_test.go"); g.Group != "tests" || g.Reason != "test" || g.Order <= sess.Order {
		t.Fatalf("test file = %+v", g)
	}
	mech := map[string]string{
		"package-lock.json": "lockfile", "gen/api.pb.go": "generated", "src/by_header.go": "generated",
		"src/fmt_only.go": "formatting", "src/новое имя.go": "rename",
	}
	for p, why := range mech {
		x := byPath(files.Files, p)
		if x.Group != "mechanical" || x.Reason != why || !x.Folded {
			t.Fatalf("%s = %s/%s folded=%v, want mechanical/%s", p, x.Group, x.Reason, x.Folded, why)
		}
	}
	// Every mechanical file comes after every reviewable one.
	lastReview, firstMech := -1, 1<<30
	for _, x := range files.Files {
		if x.Group == "mechanical" && x.Order < firstMech {
			firstMech = x.Order
		} else if x.Group != "mechanical" && x.Order > lastReview {
			lastReview = x.Order
		}
	}
	if lastReview > firstMech {
		t.Fatalf("a reviewable file follows a mechanical one: %v", order)
	}
	// Rename pairing, binary and image markers, sizes.
	rn := byPath(files.Files, "src/новое имя.go")
	if rn.Status != "renamed" || rn.OldPath != "src/old name.go" || rn.Similarity != 100 {
		t.Fatalf("rename = %+v", rn)
	}
	logo := byPath(files.Files, "assets/logo.png")
	if !logo.Binary || logo.Image != "image/png" || logo.OldSize <= 0 || logo.NewSize <= logo.OldSize || logo.Group != "other" || logo.Reason != "asset" {
		t.Fatalf("logo = %+v", logo)
	}
	if byPath(files.Files, "README.md").Group != "other" || byPath(files.Files, "README.md").Reason != "docs" {
		t.Fatalf("readme = %+v", byPath(files.Files, "README.md"))
	}
	if ng := byPath(files.Files, "src/auth_test.go"); ng.OldSize != -1 || ng.NewSize <= 0 || ng.Status != "added" {
		t.Fatalf("added file sizes = %+v", ng)
	}
	if files.Total.Files != len(files.Files) || files.Total.Mechanical != 5 || files.Base != f.repo.Base {
		t.Fatalf("totals = %+v", files.Total)
	}
	if v.Totals.Files != files.Total.Files {
		t.Fatalf("view totals = %+v", v.Totals)
	}
}

func TestLocalBranchReviewNeedsNoCodeHost(t *testing.T) {
	f := newFixture(t)
	t.Setenv("PATH", t.TempDir()) // no gh anywhere
	v, created, err := f.svc.Open(context.Background(), f.pid, review.OpenRequest{Base: "main", Head: "feature"})
	if err != nil || !created {
		t.Fatalf("open local = %v %v", created, err)
	}
	if v.Source != "local:main..feature" || v.HeadCommit != f.repo.Head || v.BaseCommit != f.repo.Base || v.Kind != "local" {
		t.Fatalf("local review = %+v", v)
	}
	if len(f.gh.Calls()) != 0 {
		t.Fatalf("gh was called for a local review: %v", f.gh.Calls())
	}
	if files := f.files(v.ID); len(files.Files) != 10 || byPath(files.Files, "src/auth.go").Group != "core" {
		t.Fatalf("files = %d", len(files.Files))
	}
	for _, bad := range []review.OpenRequest{{Base: "no-such-ref", Head: "feature"}, {Base: "--upload-pack=x", Head: "feature"}, {Head: "feature", Source: "local"}} {
		if _, _, err := f.svc.Open(context.Background(), f.pid, bad); err == nil {
			t.Fatalf("open %+v succeeded", bad)
		}
	}
	// Submitting a local review posts nowhere but records the comments as submitted.
	ctx := context.Background()
	if _, err := f.svc.CreateComment(ctx, f.pid, v.ID, review.CommentInput{Body: "general note"}); err != nil {
		t.Fatal(err)
	}
	res, err := f.svc.Submit(ctx, f.pid, v.ID, review.SubmitRequest{Verdict: "comment"})
	if err != nil || res.Posted || res.Posts || len(res.Comments) != 1 || res.Comments[0].State != "submitted" {
		t.Fatalf("local submit = %+v %v", res, err)
	}
}

func TestFileDiffHunksAndRaw(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	v := f.openPR(1)
	d, err := f.svc.FileDiff(ctx, f.pid, v.ID, "src/auth.go", review.DiffOptions{})
	if err != nil || len(d.Hunks) != 1 || d.Binary || d.TooLarge || d.Context != 3 {
		t.Fatalf("diff = %+v %v", d, err)
	}
	h := d.Hunks[0]
	adds := 0
	for _, l := range h.Lines {
		if l.Type == "add" {
			adds++
			if l.New == 0 {
				t.Fatalf("add line without number: %+v", l)
			}
		}
	}
	if adds != 8 || h.NewStart == 0 || !strings.Contains(h.Lines[len(h.Lines)-1].Text, "}") {
		t.Fatalf("hunk = %+v (adds %d)", h, adds)
	}
	// Whitespace-only change: hunks without -w, none with it.
	d, _ = f.svc.FileDiff(ctx, f.pid, v.ID, "src/fmt_only.go", review.DiffOptions{})
	dw, _ := f.svc.FileDiff(ctx, f.pid, v.ID, "src/fmt_only.go", review.DiffOptions{IgnoreWhitespace: true})
	if len(d.Hunks) == 0 || len(dw.Hunks) != 0 || !dw.WhitespaceIgnored {
		t.Fatalf("whitespace: %d hunks, with -w %d", len(d.Hunks), len(dw.Hunks))
	}
	// A rename with a Cyrillic path: the pair, no hunks (pure rename).
	rn, err := f.svc.FileDiff(ctx, f.pid, v.ID, "src/новое имя.go", review.DiffOptions{})
	if err != nil || rn.OldPath != "src/old name.go" || len(rn.Hunks) != 0 {
		t.Fatalf("rename diff = %+v %v", rn, err)
	}
	// Binary: marker, no hunks; raw bytes of both sides.
	bin, err := f.svc.FileDiff(ctx, f.pid, v.ID, "assets/logo.png", review.DiffOptions{})
	if err != nil || !bin.Binary || len(bin.Hunks) != 0 || bin.Image != "image/png" {
		t.Fatalf("binary diff = %+v %v", bin, err)
	}
	newB, ct, err := f.svc.Raw(ctx, f.pid, v.ID, "assets/logo.png", "new")
	oldB, _, err2 := f.svc.Raw(ctx, f.pid, v.ID, "assets/logo.png", "old")
	if err != nil || err2 != nil || ct != "image/png" || !strings.HasSuffix(string(newB), "new-and-longer") || !strings.HasSuffix(string(oldB), "old") {
		t.Fatalf("raw: %q %q %s %v %v", newB, oldB, ct, err, err2)
	}
	// Unknown and unsafe paths.
	for _, p := range []string{"nope.go", "../../etc/passwd", "/etc/passwd"} {
		if _, err := f.svc.FileDiff(ctx, f.pid, v.ID, p, review.DiffOptions{}); err == nil {
			t.Fatalf("diff of %q succeeded", p)
		}
	}
}

func TestViewedMarksFollowTheFileContentAcrossNewCommits(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	v := f.openPR(1)
	for _, p := range []string{"src/auth.go", "src/session.go"} {
		if _, err := f.svc.SetViewed(ctx, f.pid, v.ID, p, true); err != nil {
			t.Fatal(err)
		}
	}
	files := f.files(v.ID)
	if !byPath(files.Files, "src/auth.go").Viewed || files.ViewedN != 2 {
		t.Fatalf("viewed = %d", files.ViewedN)
	}
	// A new commit changes auth.go only.
	f.repo.AddCommit(t, "src/auth.go", strings.Replace(authContent(), "return nil", "return errExpired", 1))
	f.gh = reviewtest.NewFakeGH(t, f.repo)
	v2, err := f.svc.Patch(ctx, f.pid, v.ID, review.PatchRequest{Refresh: true})
	if err != nil || v2.HeadCommit != f.repo.Head || v2.HeadCommit == v.HeadCommit {
		t.Fatalf("refresh = %+v %v", v2.HeadCommit, err)
	}
	if reviewtest.Git(t, v2.WorktreePath, "rev-parse", "HEAD") != f.repo.Head {
		t.Fatal("worktree did not move to the new head")
	}
	files = f.files(v.ID)
	a, s := byPath(files.Files, "src/auth.go"), byPath(files.Files, "src/session.go")
	if a.Viewed || !a.ChangedSinceViewed || !s.Viewed || s.ChangedSinceViewed {
		t.Fatalf("auth viewed=%v changed=%v; session viewed=%v changed=%v", a.Viewed, a.ChangedSinceViewed, s.Viewed, s.ChangedSinceViewed)
	}
	// Marking it again clears the flag; clearing removes the mark.
	if _, err := f.svc.SetViewed(ctx, f.pid, v.ID, "src/auth.go", true); err != nil {
		t.Fatal(err)
	}
	if a := byPath(f.files(v.ID).Files, "src/auth.go"); !a.Viewed || a.ChangedSinceViewed {
		t.Fatalf("after re-view = %+v", a)
	}
	if _, err := f.svc.SetViewed(ctx, f.pid, v.ID, "src/auth.go", false); err != nil {
		t.Fatal(err)
	}
	if a := byPath(f.files(v.ID).Files, "src/auth.go"); a.Viewed || a.ChangedSinceViewed {
		t.Fatalf("after clear = %+v", a)
	}
}

func authContent() string {
	return "package auth\n\n// Login checks a user.\nfunc Login(user string) bool {\n\treturn user != \"\"\n}\n\n// ValidateToken rejects an empty or expired token.\nfunc ValidateToken(token string) error {\n\tif token == \"\" {\n\t\treturn errEmpty\n\t}\n\treturn nil\n}\n"
}

func TestCommentsValidationAndCRUD(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	v := f.openPR(1)
	d, _ := f.svc.FileDiff(ctx, f.pid, v.ID, "src/auth.go", review.DiffOptions{})
	var lines []int
	for _, l := range d.Hunks[0].Lines {
		if l.Type == "add" {
			lines = append(lines, l.New)
		}
	}
	first, last := lines[0], lines[len(lines)-1]

	line, err := f.svc.CreateComment(ctx, f.pid, v.ID, review.CommentInput{Path: "src/auth.go", Line: last, Body: "nit"})
	if err != nil || line.Kind != "line" || line.State != "pending" || line.Side != "new" {
		t.Fatalf("line = %+v %v", line, err)
	}
	rng, err := f.svc.CreateComment(ctx, f.pid, v.ID, review.CommentInput{Path: "src/auth.go", StartLine: first, Line: last, Body: "split", Suggestion: "x := 1\ny := 2"})
	if err != nil || rng.Kind != "range" || rng.Suggestion == "" {
		t.Fatalf("range = %+v %v", rng, err)
	}
	file, err := f.svc.CreateComment(ctx, f.pid, v.ID, review.CommentInput{Path: "README.md", Body: "docs?"})
	if err != nil || file.Kind != "file" {
		t.Fatalf("file = %+v %v", file, err)
	}
	gen, err := f.svc.CreateComment(ctx, f.pid, v.ID, review.CommentInput{Body: "overall: good"})
	if err != nil || gen.Kind != "general" {
		t.Fatalf("general = %+v %v", gen, err)
	}
	bad := map[string]review.CommentInput{
		"path_not_in_diff": {Path: "src/other.go", Line: 1, Body: "x"},
		"line_not_in_diff": {Path: "src/auth.go", Line: 900, Body: "x"},
		"empty_comment":    {Path: "src/auth.go", Line: first, Body: "  "},
		"invalid_request":  {Body: "general with a line", Line: 3},
		"invalid_path":     {Path: "../x", Body: "x"},
	}
	for code, in := range bad {
		_, err := f.svc.CreateComment(ctx, f.pid, v.ID, in)
		var re *review.Error
		if !errors.As(err, &re) || re.Code != code {
			t.Errorf("%s: err = %v", code, err)
		}
	}
	list, _ := f.svc.Comments(ctx, f.pid, v.ID)
	if len(list) != 4 {
		t.Fatalf("comments = %d", len(list))
	}
	nb := "better"
	up, err := f.svc.UpdateComment(ctx, f.pid, v.ID, line.ID, review.CommentUpdate{Body: &nb})
	if err != nil || up.Body != "better" {
		t.Fatalf("update = %+v %v", up, err)
	}
	if err := f.svc.DeleteComment(ctx, f.pid, v.ID, file.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.DeleteComment(ctx, f.pid, v.ID, file.ID); err == nil {
		t.Fatal("second delete succeeded")
	}
	files := f.files(v.ID)
	if got := byPath(files.Files, "src/auth.go").PendingComments; got != 2 {
		t.Fatalf("pending on auth.go = %d", got)
	}
	if n, _ := f.db.PendingComments(ctx, v.ID); n != 3 {
		t.Fatalf("pending = %d", n)
	}
}

func TestSubmitPostsExactlyThePendingCommentsAndVerdict(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	v := f.openPR(1)
	d, _ := f.svc.FileDiff(ctx, f.pid, v.ID, "src/auth.go", review.DiffOptions{})
	var lines []int
	for _, l := range d.Hunks[0].Lines {
		if l.Type == "add" {
			lines = append(lines, l.New)
		}
	}
	c1, _ := f.svc.CreateComment(ctx, f.pid, v.ID, review.CommentInput{Path: "src/auth.go", Line: lines[3], Body: "why `errEmpty`?"})
	c2, _ := f.svc.CreateComment(ctx, f.pid, v.ID, review.CommentInput{Path: "src/auth.go", StartLine: lines[1], Line: lines[2], Body: "simplify", Suggestion: "```go\nx\n```"})
	_, _ = f.svc.CreateComment(ctx, f.pid, v.ID, review.CommentInput{Path: "README.md", Body: "file-level"})
	_, _ = f.svc.CreateComment(ctx, f.pid, v.ID, review.CommentInput{Body: "general words"})

	if f.gh.WritesCalled() || len(f.gh.Posts()) != 0 {
		t.Fatalf("something was posted before submit: %v", f.gh.Calls())
	}
	// Invalid requests post nothing.
	for _, bad := range []review.SubmitRequest{{Verdict: "merge"}, {Verdict: ""}, {Verdict: "comment", CommentIDs: []string{c1.ID}}} {
		if _, err := f.svc.Submit(ctx, f.pid, v.ID, bad); err == nil {
			t.Fatalf("submit %+v succeeded", bad)
		}
	}
	if f.gh.WritesCalled() {
		t.Fatal("a refused submit posted")
	}
	pre, err := f.svc.SubmitPreview(ctx, f.pid, v.ID, review.SubmitRequest{Verdict: "request_changes", Body: "please look"})
	if err != nil || len(pre.Comments) != 4 || pre.Body != "please look\n\ngeneral words" || !pre.Posts || len(pre.Payload) == 0 {
		t.Fatalf("preview = %+v %v", pre, err)
	}
	if f.gh.WritesCalled() {
		t.Fatal("the preview posted")
	}
	res, err := f.svc.Submit(ctx, f.pid, v.ID, review.SubmitRequest{Verdict: "request_changes", Body: "please look", CommentIDs: ids(pre.Comments)})
	if err != nil || !res.Posted || res.URL == "" {
		t.Fatalf("submit = %+v %v", res, err)
	}
	posts := f.gh.Posts()
	if len(posts) != 1 {
		t.Fatalf("posts = %d", len(posts))
	}
	if string(res.Payload) != posts[0] {
		t.Fatalf("preview payload differs from what was posted:\n%s\n%s", res.Payload, posts[0])
	}
	var body struct {
		CommitID string `json:"commit_id"`
		Body     string `json:"body"`
		Event    string `json:"event"`
		Comments []struct {
			Path        string `json:"path"`
			Body        string `json:"body"`
			Line        int    `json:"line"`
			Side        string `json:"side"`
			StartLine   int    `json:"start_line"`
			StartSide   string `json:"start_side"`
			SubjectType string `json:"subject_type"`
		} `json:"comments"`
	}
	if err := json.Unmarshal([]byte(posts[0]), &body); err != nil {
		t.Fatal(err)
	}
	if body.Event != "REQUEST_CHANGES" || body.CommitID != f.repo.Head || body.Body != "please look\n\ngeneral words" || len(body.Comments) != 3 {
		t.Fatalf("posted = %+v", body)
	}
	if c := body.Comments[0]; c.Path != "src/auth.go" || c.Line != lines[3] || c.Side != "RIGHT" || c.Body != "why `errEmpty`?" || c.StartLine != 0 {
		t.Fatalf("line comment = %+v", c)
	}
	if c := body.Comments[1]; c.StartLine != lines[1] || c.Line != lines[2] || c.StartSide != "RIGHT" ||
		!strings.Contains(c.Body, "````suggestion\n```go\nx\n```\n````") {
		t.Fatalf("range comment = %+v", c)
	}
	if c := body.Comments[2]; c.Path != "README.md" || c.SubjectType != "file" || c.Line != 0 {
		t.Fatalf("file comment = %+v", c)
	}
	// Bookkeeping: comments submitted, head recorded, nothing pending, no second post.
	if n, _ := f.db.PendingComments(ctx, v.ID); n != 0 || res.Review.LastSubmittedHead != f.repo.Head || res.Review.PendingComments != 0 {
		t.Fatalf("after submit: pending=%d head=%s", n, res.Review.LastSubmittedHead)
	}
	if _, err := f.svc.Submit(ctx, f.pid, v.ID, review.SubmitRequest{Verdict: "comment"}); err == nil {
		t.Fatal("an empty second review was posted")
	}
	if len(f.gh.Posts()) != 1 {
		t.Fatal("second post")
	}
	if a, err := f.svc.UpdateComment(ctx, f.pid, v.ID, c1.ID, review.CommentUpdate{}); err == nil {
		t.Fatalf("a submitted comment was edited: %+v", a)
	}
	// Approve with nothing else is allowed.
	if r, err := f.svc.Submit(ctx, f.pid, v.ID, review.SubmitRequest{Verdict: "approve"}); err != nil || !r.Posted {
		t.Fatalf("approve = %v", err)
	}
	_ = c2
}

func ids(list []projectstore.ReviewComment) []string {
	var out []string
	for _, c := range list {
		out = append(out, c.ID)
	}
	return out
}

func TestFailedPostKeepsCommentsPending(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	v := f.openPR(1)
	_, _ = f.svc.CreateComment(ctx, f.pid, v.ID, review.CommentInput{Body: "keep me"})
	f.gh.LoggedOut(t, true)
	_, err := f.svc.Submit(ctx, f.pid, v.ID, review.SubmitRequest{Verdict: "comment"})
	var re *review.Error
	if !errors.As(err, &re) || re.Code != "not_logged_in" || re.Command != "gh auth login" {
		t.Fatalf("err = %v", err)
	}
	if n, _ := f.db.PendingComments(ctx, v.ID); n != 1 {
		t.Fatalf("pending = %d after a failed post", n)
	}
	f.gh.LoggedOut(t, false)
	if r, err := f.svc.Submit(ctx, f.pid, v.ID, review.SubmitRequest{Verdict: "comment"}); err != nil || !r.Posted {
		t.Fatalf("retry = %v", err)
	}
}

func TestFindingsAreStoredKeptAsCommentsAndDismissed(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	v := f.openPR(1)
	d, _ := f.svc.FileDiff(ctx, f.pid, v.ID, "src/auth.go", review.DiffOptions{})
	var lines []int
	for _, l := range d.Hunks[0].Lines {
		if l.Type == "add" {
			lines = append(lines, l.New)
		}
	}
	got, err := f.svc.AddFindings(ctx, f.pid, v.ID, []projectstore.ReviewFinding{
		{Path: "src/auth.go", StartLine: lines[0], EndLine: lines[1], Severity: "high", Statement: "token expiry is never checked", Scenario: "an expired token is accepted", Patch: "if expired { return err }", Rank: 1},
		{Path: "src/auth.go", StartLine: lines[2], EndLine: lines[2], Severity: "low", Statement: "naming", Rank: 2},
	})
	if err != nil || len(got) != 2 {
		t.Fatal(err)
	}
	list, _ := f.svc.Findings(ctx, f.pid, v.ID)
	if len(list) != 2 || list[0].Severity != "high" || list[0].Status != "new" {
		t.Fatalf("findings = %+v", list)
	}
	if byPath(f.files(v.ID).Files, "src/auth.go").Findings != 2 {
		t.Fatal("finding count not on the file")
	}
	kept, err := f.svc.DecideFinding(ctx, f.pid, v.ID, list[0].ID, review.FindingDecision{Status: "kept"})
	if err != nil || kept.Comment == nil || kept.Comment.Kind != "range" || kept.Comment.FindingID != list[0].ID || kept.Comment.Suggestion == "" || kept.Finding.Status != "kept" {
		t.Fatalf("kept = %+v %v", kept, err)
	}
	dis, err := f.svc.DecideFinding(ctx, f.pid, v.ID, list[1].ID, review.FindingDecision{Status: "dismissed", Reason: "style"})
	if err != nil || dis.Comment != nil || dis.Finding.DismissReason != "style" {
		t.Fatalf("dismissed = %+v %v", dis, err)
	}
	if byPath(f.files(v.ID).Files, "src/auth.go").Findings != 1 {
		t.Fatal("a dismissed finding still counts")
	}
	// Nothing was posted by any of it.
	if f.gh.WritesCalled() {
		t.Fatal("findings posted")
	}
}

func TestSweepRemovesWorktreesButNeverWithPendingComments(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	v := f.openPR(1)
	local, _, err := f.svc.Open(ctx, f.pid, review.OpenRequest{Base: "main", Head: "feature"})
	if err != nil {
		t.Fatal(err)
	}
	closed := "closed"
	// Pending comment: closing keeps the worktree.
	_, _ = f.svc.CreateComment(ctx, f.pid, v.ID, review.CommentInput{Body: "unsent"})
	c, err := f.svc.Patch(ctx, f.pid, v.ID, review.PatchRequest{State: &closed})
	if err != nil || c.State != "closed" || !c.WorktreePresent {
		t.Fatalf("close with pending = %+v %v", c.State, err)
	}
	// Closed without pending comments: removed.
	lc, err := f.svc.Patch(ctx, f.pid, local.ID, review.PatchRequest{State: &closed})
	if err != nil || lc.WorktreePresent || lc.WorktreePath != "" {
		t.Fatalf("close local = present %v path %q %v", lc.WorktreePresent, lc.WorktreePath, err)
	}
	if _, err := os.Stat(local.WorktreePath); !os.IsNotExist(err) {
		t.Fatalf("worktree directory still there: %v", err)
	}
	if out := reviewtest.Git(t, f.repo.Dir, "worktree", "list", "--porcelain"); strings.Contains(out, local.WorktreePath) {
		t.Fatalf("git still lists the worktree:\n%s", out)
	}
	// Reopening re-creates it.
	open := "open"
	lr, err := f.svc.Patch(ctx, f.pid, local.ID, review.PatchRequest{State: &open})
	if err != nil || !lr.WorktreePresent || lr.State != "open" {
		t.Fatalf("reopen = %+v %v", lr.WorktreePresent, err)
	}
	// Unused for 14 days: removed, unless comments are pending.
	// (last_used_at is set far in the past; the service clock is now.)
	if err := f.db.Exec_(ctx, `UPDATE reviews SET last_used_at = '2020-01-01T00:00:00.000Z'`); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.Sweep(ctx, f.pid); err != nil {
		t.Fatal(err)
	}
	rs, _ := f.db.Reviews(ctx, "")
	for _, r := range rs {
		switch r.ID {
		case v.ID:
			if r.WorktreePath == "" {
				t.Fatal("the worktree with pending comments was removed")
			}
		case local.ID:
			if r.WorktreePath != "" {
				t.Fatal("the stale worktree was kept")
			}
		}
	}
	// Deleting the pending comment lets the next sweep remove it.
	cs, _ := f.svc.Comments(ctx, f.pid, v.ID)
	_ = f.svc.DeleteComment(ctx, f.pid, v.ID, cs[0].ID)
	_ = f.svc.Sweep(ctx, f.pid)
	if r, _ := f.db.Review(ctx, v.ID); r.WorktreePath != "" {
		t.Fatal("worktree kept after the comments were gone")
	}
}

func TestReviewSurvivesARestart(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	v := f.openPR(1)
	_, _ = f.svc.SetViewed(ctx, f.pid, v.ID, "src/auth.go", true)
	cm, _ := f.svc.CreateComment(ctx, f.pid, v.ID, review.CommentInput{Body: "remember"})
	_, _ = f.svc.AddFindings(ctx, f.pid, v.ID, []projectstore.ReviewFinding{{Path: "src/auth.go", Statement: "s"}})

	store2, err := projectstore.Open(f.data) // a second open of the same data directory
	if err != nil {
		t.Fatal(err)
	}
	defer store2.Close()
	svc2 := review.New(store2, events.NewHub(), review.Options{Host: codehost.NewGH()})
	got, err := svc2.Get(ctx, f.pid, v.ID)
	if err != nil || got.PendingComments != 1 || got.ViewedCount != 1 || got.FindingCount != 1 || !got.WorktreePresent {
		t.Fatalf("after restart = %+v %v", got, err)
	}
	cs, _ := svc2.Comments(ctx, f.pid, v.ID)
	if len(cs) != 1 || cs[0].ID != cm.ID {
		t.Fatalf("comments = %+v", cs)
	}
}

func TestEventsAreSentOnChange(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	ch, cancel := f.hub.Subscribe(f.pid)
	defer cancel()
	v := f.openPR(1)
	_, _ = f.svc.CreateComment(ctx, f.pid, v.ID, review.CommentInput{Body: "x"})
	var reasons []string
	for len(reasons) < 2 {
		select {
		case ev := <-ch:
			if ev.Type != "review.updated" {
				continue
			}
			var p struct {
				ReviewID string `json:"review_id"`
				Reason   string `json:"reason"`
				Review   struct {
					PendingComments int `json:"pending_comments"`
				} `json:"review"`
			}
			if err := json.Unmarshal(ev.Data, &p); err != nil || p.ReviewID != v.ID {
				t.Fatalf("event = %s %v", ev.Data, err)
			}
			reasons = append(reasons, p.Reason)
		case <-time.After(5 * time.Second):
			t.Fatalf("events so far: %v", reasons)
		}
	}
	if reasons[0] != "created" || reasons[1] != "comment" {
		t.Fatalf("reasons = %v", reasons)
	}
}

func TestGHEnvironmentIsForThatCommandOnly(t *testing.T) {
	f := newFixture(t)
	t.Setenv("GH_TOKEN", "ghp_secret_for_gh_only")
	t.Setenv("GH_HOST", "ghe.example.com")
	t.Setenv("ANTHROPIC_API_KEY", "sk-must-not-leak")
	t.Setenv("GITHUB_TOKEN", "must-not-leak-either")
	if _, err := f.svc.ListPRs(context.Background(), f.pid, ""); err != nil {
		t.Fatal(err)
	}
	env := f.gh.LastEnv()
	if !strings.Contains(env, "GH_TOKEN=\"ghp_secret_for_gh_only\"") || !strings.Contains(env, "GH_HOST=\"ghe.example.com\"") {
		t.Fatalf("gh did not get its GH_* variables:\n%s", env)
	}
	if strings.Contains(env, "sk-must-not-leak") || strings.Contains(env, "must-not-leak-either") {
		t.Fatalf("a non-GH secret reached gh:\n%s", env)
	}
	if !strings.Contains(env, "GH_PROMPT_DISABLED") {
		t.Fatal("gh may prompt")
	}
}
