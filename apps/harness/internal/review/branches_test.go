package review_test

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/review"
	"github.com/ndolinschi/Octo/apps/harness/internal/review/reviewtest"
)

func commitOn(t *testing.T, dir, file, date string) {
	t.Helper()
	t.Setenv("GIT_COMMITTER_DATE", date)
	t.Setenv("GIT_AUTHOR_DATE", date)
	if err := os.WriteFile(dir+"/"+file, []byte(file+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	reviewtest.Git(t, dir, "add", file)
	reviewtest.Git(t, dir, "commit", "-q", "-m", "add "+file)
}

func TestBranchesListLocalBranchesAgainstTheDefaultBase(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	dir := f.repo.Dir
	// refs/remotes/origin/HEAD names the default branch.
	reviewtest.Git(t, dir, "remote", "set-head", "origin", "main")

	// topic: two commits ahead of main. Then main moves on one commit and is pushed.
	reviewtest.Git(t, dir, "checkout", "-q", "-b", "topic", "main")
	commitOn(t, dir, "t1.txt", "2026-11-05T10:00:00Z")
	commitOn(t, dir, "t2.txt", "2026-11-06T10:00:00Z")
	reviewtest.Git(t, dir, "checkout", "-q", "main")
	commitOn(t, dir, "m1.txt", "2026-11-07T10:00:00Z")
	reviewtest.Git(t, dir, "push", "-q", "origin", "main")
	// The local main is then behind its remote-tracking ref: counts are against origin/main.
	moved := reviewtest.Git(t, dir, "rev-parse", "HEAD")
	reviewtest.Git(t, dir, "reset", "-q", "--hard", f.repo.Base)
	if got := reviewtest.Git(t, dir, "rev-parse", "refs/remotes/origin/main"); got != moved {
		t.Fatalf("origin/main = %s want %s", got, moved)
	}
	reviewtest.Git(t, dir, "checkout", "-q", "topic")

	out, err := f.svc.Branches(ctx, f.pid, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if out.Base != "main" || out.DefaultBase != "main" || out.Folder != "repo" || out.Truncated {
		t.Fatalf("out = %+v", out)
	}
	if len(out.Branches) != 3 || out.Branches[0].Name != "topic" || !out.Branches[0].Current {
		t.Fatalf("branches = %+v", out.Branches)
	}
	by := map[string]int{}
	for i, b := range out.Branches {
		by[b.Name] = i
	}
	topic, main, feature := out.Branches[by["topic"]], out.Branches[by["main"]], out.Branches[by["feature"]]
	if topic.Ahead != 2 || topic.Behind != 1 || topic.Commit.Subject != "add t2.txt" || topic.Commit.SHA == "" || topic.Commit.Date == "" {
		t.Fatalf("topic = %+v", topic)
	}
	if main.Ahead != 0 || main.Behind != 1 || main.Current || main.Commit.SHA != f.repo.Base {
		t.Fatalf("main (local, behind origin/main %s) = %+v", moved, main)
	}
	if feature.Ahead == 0 || feature.Behind != 1 {
		t.Fatalf("feature = %+v", feature)
	}
	// After the current one, the newest commit first: topic's date is newer than the base's.
	if out.Branches[1].Commit.Date < out.Branches[2].Commit.Date {
		t.Fatalf("not newest first: %+v", out.Branches)
	}

	// Another base: against feature, main is behind it.
	out, err = f.svc.Branches(ctx, f.pid, "repo", "feature")
	if err != nil || out.Base != "feature" || out.DefaultBase != "main" {
		t.Fatalf("base feature = %+v %v", out, err)
	}
	for _, b := range out.Branches {
		if b.Name == "feature" && (b.Ahead != 0 || b.Behind != 0) {
			t.Fatalf("feature against itself = %+v", b)
		}
	}
}

func TestBranchesRefuseAnUnknownBaseAndNeedNoCodeHost(t *testing.T) {
	f := newFixture(t)
	f.gh.LoggedOut(t, true)
	ctx := context.Background()
	for _, base := range []string{"nope", "-x", "a..b"} {
		_, err := f.svc.Branches(ctx, f.pid, "", base)
		var re *review.Error
		if !errors.As(err, &re) || re.Kind != review.KindInvalid {
			t.Fatalf("base %q: %v", base, err)
		}
	}
	// No origin/HEAD: the default falls back to main.
	out, err := f.svc.Branches(ctx, f.pid, "", "")
	if err != nil || out.DefaultBase != "main" || out.Base != "main" {
		t.Fatalf("out = %+v %v", out, err)
	}
	if len(f.gh.Calls()) != 0 {
		t.Fatalf("gh was called: %v", f.gh.Calls())
	}
}

func TestBranchesAreCappedAt200(t *testing.T) {
	f := newFixture(t)
	for i := 0; i < 205; i++ {
		reviewtest.Git(t, f.repo.Dir, "branch", "b"+itoa(i), "main")
	}
	out, err := f.svc.Branches(context.Background(), f.pid, "", "")
	if err != nil || len(out.Branches) != 200 || !out.Truncated {
		t.Fatalf("branches = %d truncated=%v %v", len(out.Branches), out.Truncated, err)
	}
}

func TestBranchesPageChunks(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	p1, err := f.svc.BranchesPage(ctx, f.pid, "", "", 1, 1)
	if err != nil || len(p1.Branches) != 1 || p1.Total != 2 || p1.Page != 1 || p1.PerPage != 1 || p1.NextPage == nil || *p1.NextPage != 2 {
		t.Fatalf("p1 = %+v %v", p1, err)
	}
	p2, err := f.svc.BranchesPage(ctx, f.pid, "", "", 2, 1)
	if err != nil || len(p2.Branches) != 1 || p2.Total != 2 || p2.NextPage != nil {
		t.Fatalf("p2 = %+v %v", p2, err)
	}
	if p1.Branches[0].Name == p2.Branches[0].Name {
		t.Fatalf("duplicate branch across pages: %s", p1.Branches[0].Name)
	}
}
