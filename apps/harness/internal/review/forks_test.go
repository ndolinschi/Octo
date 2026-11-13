package review_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/codehost"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/review"
	"github.com/ndolinschi/Octo/apps/harness/internal/review/reviewtest"
)

const (
	forkRepo   = "eCommerce-Ebro/shop"
	parentRepo = "eCommerce-Bedrock/shop"
)

// forkFixture is a folder that is a clone of a fork: origin is the fork, the
// parent (which only the host knows to be the parent) has its own bare
// repository. Fork pull requests: 1 and 3. Parent pull requests: 3 and 7.
type forkFixture struct {
	*fixture
	parentBare string
	parentHead string
}

func newForkFixture(t *testing.T, withUpstream bool) *forkFixture {
	t.Helper()
	repo := reviewtest.NewRepo(t)
	parentBare, parentHead := repo.AddParent(t, 3, 7)
	gh := reviewtest.NewFakeGH(t, repo,
		reviewtest.PR{Repo: forkRepo, Number: 1, Title: "Fork one", Author: "alice", Comment: "ok"},
		reviewtest.PR{Repo: forkRepo, Number: 3, Title: "Fork three", Author: "alice"},
		reviewtest.PR{Repo: parentRepo, Number: 3, Title: "Parent three", Author: "bob", Head: parentHead},
		reviewtest.PR{Repo: parentRepo, Number: 7, Title: "Parent seven", Author: "bob", Head: parentHead, Requested: true},
	)
	gh.SetRepo(t, forkRepo, parentRepo)
	gh.SetRepo(t, parentRepo, "")
	if withUpstream {
		repo.ForkRemotes(t, "github.com", forkRepo, repo.Origin, parentRepo, parentBare)
	} else {
		repo.ForkRemotes(t, "github.com", forkRepo, repo.Origin, "", "")
	}
	// The parent's address is only derivable from the fork's: make it fetchable.
	reviewtest.Git(t, repo.Dir, "config", "url."+parentBare+".insteadOf", "https://github.com/"+parentRepo+".git")
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
	return &forkFixture{fixture: f, parentBare: parentBare, parentHead: parentHead}
}

func repoNumbers(l review.PRList) string {
	var s []string
	for _, r := range l.PRs {
		s = append(s, r.Repo+"#"+itoa(r.Number))
	}
	return strings.Join(s, " ")
}

func itoa(n int) string {
	if n < 10 {
		return string(rune('0' + n))
	}
	return itoa(n/10) + string(rune('0'+n%10))
}

// The owner's failure: a clone of a fork whose only remote is the fork. The list
// used to show the parent (gh's own default repository) and the fork's pull
// request was refused as repo_mismatch.
func TestForkCloneListsTheForkAndItsParent(t *testing.T) {
	f := newForkFixture(t, false)
	ctx := context.Background()
	l, err := f.svc.ListPRs(ctx, f.pid, review.ListOptions{})
	if err != nil || !l.Available {
		t.Fatalf("list = %+v %v", l, err)
	}
	if l.Repo != forkRepo || len(l.Repos) != 2 {
		t.Fatalf("repo = %q repos = %+v", l.Repo, l.Repos)
	}
	o, p := l.Repos[0], l.Repos[1]
	if o.Repo != forkRepo || o.Role != "origin" || o.Remote != "origin" || !o.Default || o.Hostname != "github.com" || o.Host != "github" {
		t.Fatalf("origin ref = %+v", o)
	}
	if p.Repo != parentRepo || p.Role != "parent" || p.Remote != "" || p.Default {
		t.Fatalf("parent ref = %+v", p)
	}
	if got := repoNumbers(l); got != forkRepo+"#3 "+forkRepo+"#1" && got != forkRepo+"#1 "+forkRepo+"#3" {
		t.Fatalf("default list = %s", got)
	}
	// gh's own default repository is never asked.
	for _, c := range f.gh.Calls() {
		if c == "repo view --json name,owner,url" {
			t.Fatalf("gh's default repository was used: %v", f.gh.Calls())
		}
		if strings.HasPrefix(c, "pr list") && !strings.Contains(c, "--repo github.com/") {
			t.Fatalf("a pr list without --repo: %q", c)
		}
	}

	pl, err := f.svc.ListPRs(ctx, f.pid, review.ListOptions{Repo: parentRepo})
	if err != nil || pl.Repo != parentRepo || pl.PRs[0].Repo != parentRepo || len(pl.PRs) != 2 || pl.PRs[0].Number != 7 && pl.PRs[0].Number != 3 {
		t.Fatalf("parent list = %s %v", repoNumbers(pl), err)
	}
	// The choice is remembered for the folder.
	again, _ := f.svc.ListPRs(ctx, f.pid, review.ListOptions{})
	if again.Repo != parentRepo {
		t.Fatalf("remembered repo = %q", again.Repo)
	}
	all, err := f.svc.ListPRs(ctx, f.pid, review.ListOptions{Repo: "all"})
	if err != nil || all.Repo != "all" || all.Total != 4 {
		t.Fatalf("all = %s %v", repoNumbers(all), err)
	}
	seen := map[string]bool{}
	for _, r := range all.PRs {
		seen[r.Repo+"#"+itoa(r.Number)] = true
	}
	for _, want := range []string{forkRepo + "#1", forkRepo + "#3", parentRepo + "#3", parentRepo + "#7"} {
		if !seen[want] {
			t.Fatalf("all lacks %s: %s", want, repoNumbers(all))
		}
	}
	if _, err := f.svc.ListPRs(ctx, f.pid, review.ListOptions{Repo: "nobody/else"}); err == nil || !strings.Contains(err.Error(), "invalid_repo") {
		t.Fatalf("an unknown repo = %v", err)
	}
}

func TestDefaultRepositoryFollowsTheTrackingBranchThenOrigin(t *testing.T) {
	f := newForkFixture(t, true)
	ctx := context.Background()
	l, _ := f.svc.ListPRs(ctx, f.pid, review.ListOptions{})
	if len(l.Repos) != 2 || l.Repo != forkRepo {
		t.Fatalf("no tracking: repo = %q repos = %+v", l.Repo, l.Repos)
	}
	// upstream is a remote of its own (not duplicated by the fork's parent).
	if l.Repos[1].Repo != parentRepo || l.Repos[1].Role != "upstream" || l.Repos[1].Remote != "upstream" {
		t.Fatalf("upstream ref = %+v", l.Repos[1])
	}
	reviewtest.Git(t, f.repo.Dir, "config", "branch.main.remote", "upstream")
	reviewtest.Git(t, f.repo.Dir, "config", "branch.main.merge", "refs/heads/main")
	l, err := f.svc.ListPRs(ctx, f.pid, review.ListOptions{Refresh: true})
	if err != nil || l.Repo != parentRepo || l.Repos[0].Default || !l.Repos[1].Default {
		t.Fatalf("tracking upstream: repo = %q repos = %+v %v", l.Repo, l.Repos, err)
	}
}

func TestOpenByForkURLAndByParentURLFetchesFromTheirOwnRepository(t *testing.T) {
	f := newForkFixture(t, false)
	ctx := context.Background()
	remotesBefore := reviewtest.Git(t, f.repo.Dir, "remote")

	fv, created, err := f.svc.Open(ctx, f.pid, review.OpenRequest{URL: "https://github.com/" + forkRepo + "/pull/1"})
	if err != nil || !created || fv.Repo != forkRepo || fv.Number != 1 || fv.HeadCommit != f.repo.Head {
		t.Fatalf("open fork PR = %+v %v", fv, err)
	}
	pv, created, err := f.svc.Open(ctx, f.pid, review.OpenRequest{URL: "https://github.com/" + parentRepo + "/pull/7"})
	if err != nil || !created || pv.Repo != parentRepo || pv.Number != 7 {
		t.Fatalf("open parent PR = %+v %v", pv, err)
	}
	// The head exists only in the parent's repository: it was fetched from there by URL.
	if pv.HeadCommit != f.parentHead || pv.HeadCommit == fv.HeadCommit {
		t.Fatalf("parent head = %s want %s", pv.HeadCommit, f.parentHead)
	}
	// Nothing was added to the folder's remotes.
	if got := reviewtest.Git(t, f.repo.Dir, "remote"); got != remotesBefore || got != "origin" {
		t.Fatalf("remotes = %q (before %q)", got, remotesBefore)
	}
	// The pull request calls named their repository.
	var viewed bool
	for _, c := range f.gh.Calls() {
		if strings.HasPrefix(c, "pr view 7") && strings.Contains(c, "--repo github.com/"+parentRepo) {
			viewed = true
		}
	}
	if !viewed {
		t.Fatalf("no pr view 7 with --repo: %v", f.gh.Calls())
	}

	// A URL of an unrelated repository is refused and names the folder's repositories.
	_, _, err = f.svc.Open(ctx, f.pid, review.OpenRequest{URL: "https://github.com/other/repo/pull/1"})
	var re *review.Error
	if !errors.As(err, &re) || re.Code != "repo_mismatch" || len(re.Repos) != 2 ||
		!strings.Contains(re.Message, forkRepo) || !strings.Contains(re.Message, parentRepo) {
		t.Fatalf("mismatch = %v", err)
	}
}

func TestOpenByBareNumberLooksInEveryRepository(t *testing.T) {
	f := newForkFixture(t, false)
	ctx := context.Background()

	// Only the parent has 7.
	v, _, err := f.svc.Open(ctx, f.pid, review.OpenRequest{PR: 7})
	if err != nil || v.Repo != parentRepo {
		t.Fatalf("open 7 = %+v %v", v, err)
	}
	// Only the fork has 1.
	v, _, err = f.svc.Open(ctx, f.pid, review.OpenRequest{PR: 1})
	if err != nil || v.Repo != forkRepo {
		t.Fatalf("open 1 = %+v %v", v, err)
	}
	// Both have 3: the caller is asked which.
	_, _, err = f.svc.Open(ctx, f.pid, review.OpenRequest{PR: 3})
	var re *review.Error
	if !errors.As(err, &re) || re.Code != "ambiguous_pr" || re.Kind != review.KindConflict || len(re.Repos) != 2 {
		t.Fatalf("open 3 = %v", err)
	}
	// Saying which opens it.
	v, _, err = f.svc.Open(ctx, f.pid, review.OpenRequest{PR: 3, Repo: parentRepo})
	if err != nil || v.Repo != parentRepo || v.Number != 3 {
		t.Fatalf("open 3 in the parent = %+v %v", v, err)
	}
	if _, _, err = f.svc.Open(ctx, f.pid, review.OpenRequest{PR: 3, Repo: "nobody/else"}); err == nil || !strings.Contains(err.Error(), "invalid_repo") {
		t.Fatalf("open in an unknown repo = %v", err)
	}
	// A number nobody has is not found.
	if _, _, err = f.svc.Open(ctx, f.pid, review.OpenRequest{PR: 99}); err == nil {
		t.Fatal("PR 99 opened")
	}
}

func TestSubmitGoesToThePullRequestsOwnRepository(t *testing.T) {
	f := newForkFixture(t, false)
	ctx := context.Background()
	pv, _, err := f.svc.Open(ctx, f.pid, review.OpenRequest{URL: "https://github.com/" + parentRepo + "/pull/7"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.CreateComment(ctx, f.pid, pv.ID, review.CommentInput{Body: "note for the parent"}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Submit(ctx, f.pid, pv.ID, review.SubmitRequest{Verdict: "comment"}); err != nil {
		t.Fatal(err)
	}
	var post string
	for _, c := range f.gh.Calls() {
		if strings.Contains(c, "--method POST") {
			post = c
		}
	}
	if !strings.Contains(post, "repos/"+parentRepo+"/pulls/7/reviews") || strings.Contains(post, forkRepo) {
		t.Fatalf("post call = %q", post)
	}

	// And the fork's own pull request goes to the fork.
	fv, _, err := f.svc.Open(ctx, f.pid, review.OpenRequest{URL: "https://github.com/" + forkRepo + "/pull/1"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.CreateComment(ctx, f.pid, fv.ID, review.CommentInput{Body: "note for the fork"}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Submit(ctx, f.pid, fv.ID, review.SubmitRequest{Verdict: "comment"}); err != nil {
		t.Fatal(err)
	}
	calls := f.gh.Calls()
	if last := calls[len(calls)-1]; !strings.Contains(last, "repos/"+forkRepo+"/pulls/1/reviews") {
		t.Fatalf("fork post call = %q", last)
	}
}

func TestFetchURLBuildsAddressesWithoutTouchingRemotes(t *testing.T) {
	rs := []codehost.Remote{
		{Name: "origin", Host: "github.com", Owner: "fork", Repo: "shop", URL: "git@github.com:fork/shop.git"},
		{Name: "up", Host: "ghe.example.com", Owner: "corp", Repo: "shop", URL: "https://ghe.example.com/corp/shop"},
	}
	cases := []struct {
		repo codehost.Repo
		want string
	}{
		{codehost.Repo{Owner: "fork", Name: "shop"}, "git@github.com:fork/shop.git"},
		{codehost.Repo{Owner: "parent", Name: "shop", Host: "github.com"}, "git@github.com:parent/shop.git"},
		{codehost.Repo{Owner: "other", Name: "tool", Host: "ghe.example.com"}, "https://ghe.example.com/other/tool"},
		{codehost.Repo{Owner: "x", Name: "y", Host: "git.other.org"}, "https://git.other.org/x/y.git"},
	}
	for _, c := range cases {
		if got, ok := codehost.FetchURL(rs, c.repo); !ok || got != c.want {
			t.Errorf("FetchURL(%+v) = %q %v, want %q", c.repo, got, ok, c.want)
		}
	}
	if _, ok := codehost.FetchURL(nil, codehost.Repo{Owner: "a", Name: "b"}); ok {
		t.Error("no remotes should give no address")
	}
}
