package review_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/review"
	"github.com/ndolinschi/Octo/apps/harness/internal/review/reviewtest"
)

func numbers(l review.PRList) []int {
	var n []int
	for _, p := range l.PRs {
		n = append(n, p.Number)
	}
	return n
}

func sameInts(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func countCalls(f *fixture, prefix string) int {
	n := 0
	for _, c := range f.gh.Calls() {
		if strings.HasPrefix(c, prefix) {
			n++
		}
	}
	return n
}

func manyPRs(base string) []reviewtest.PR {
	return []reviewtest.PR{
		// Reviewed by me at an older commit: new commits since my review.
		{Number: 1, Title: "Add token validation", Author: "alice", Comment: "looks fine", ReviewedBy: reviewtest.Viewer, ReviewedCommit: base, UpdatedAt: "2026-11-05T10:00:00Z"},
		{Number: 2, Title: "Unrelated change", Author: "bob", Requested: true, UpdatedAt: "2026-11-04T10:00:00Z"},
		{Number: 3, Title: "WIP: refactor", Author: reviewtest.Viewer, Draft: true, UpdatedAt: "2026-11-09T10:00:00Z"},
		{Number: 4, Title: "Fix typo", Author: "dave", UpdatedAt: "2026-11-02T10:00:00Z", ReviewedBy: "someone-else"},
	}
}

func TestListPRsAllOpenNewestActivityFirstWithFiltersAndFields(t *testing.T) {
	f := newFixture(t, manyPRs("1111111111111111111111111111111111111111")...)
	ctx := context.Background()

	all, err := f.svc.ListPRs(ctx, f.pid, review.ListOptions{})
	if err != nil || !all.Available {
		t.Fatalf("all = %+v %v", all, err)
	}
	if !sameInts(numbers(all), []int{3, 1, 2, 4}) || all.Filter != "all" || all.Total != 4 || all.NextPage != nil || all.Page != 1 || all.PerPage != 30 {
		t.Fatalf("all: order %v filter=%s total=%d next=%v", numbers(all), all.Filter, all.Total, all.NextPage)
	}
	byNum := map[int]review.PRRow{}
	for _, r := range all.PRs {
		byNum[r.Number] = r
	}
	if r := byNum[1]; r.Comments != 1 || !r.ReviewedByMe || !r.NewSinceMyReview || r.Mine {
		t.Fatalf("PR 1 fields = comments %d reviewed %v new %v mine %v", r.Comments, r.ReviewedByMe, r.NewSinceMyReview, r.Mine)
	}
	if r := byNum[3]; !r.Mine || !r.Draft || r.ReviewedByMe || r.NewSinceMyReview {
		t.Fatalf("PR 3 fields = %+v", r.PR)
	}
	if r := byNum[4]; r.ReviewedByMe || r.NewSinceMyReview || r.Comments != 0 {
		t.Fatalf("PR 4 fields = %+v", r.PR)
	}
	if r := byNum[2]; !r.ReviewRequested {
		t.Fatalf("PR 2 should ask for my review")
	}

	for filter, want := range map[string][]int{
		"review_requested": {2}, "mine": {3}, "drafts": {3}, "all": {3, 1, 2, 4},
	} {
		l, err := f.svc.ListPRs(ctx, f.pid, review.ListOptions{Filter: filter})
		if err != nil || !sameInts(numbers(l), want) || l.Total != len(want) {
			t.Fatalf("filter %s = %v total %d %v, want %v", filter, numbers(l), l.Total, err, want)
		}
	}
	if _, err := f.svc.ListPRs(ctx, f.pid, review.ListOptions{Filter: "nope"}); err == nil {
		t.Fatal("an unknown filter must be refused")
	}

	// Search: title, author, number.
	for q, want := range map[string][]int{"typo": {4}, "BOB": {2}, "#3": {3}, "4": {4}, "zzz": nil} {
		l, _ := f.svc.ListPRs(ctx, f.pid, review.ListOptions{Q: q})
		if !sameInts(numbers(l), want) {
			t.Fatalf("q=%q = %v, want %v", q, numbers(l), want)
		}
	}

	// Paging.
	p1, _ := f.svc.ListPRs(ctx, f.pid, review.ListOptions{PerPage: 3})
	if !sameInts(numbers(p1), []int{3, 1, 2}) || p1.NextPage == nil || *p1.NextPage != 2 || p1.Total != 4 {
		t.Fatalf("page 1 = %v next=%v total=%d", numbers(p1), p1.NextPage, p1.Total)
	}
	p2, _ := f.svc.ListPRs(ctx, f.pid, review.ListOptions{PerPage: 3, Page: 2})
	if !sameInts(numbers(p2), []int{4}) || p2.NextPage != nil || p2.Page != 2 {
		t.Fatalf("page 2 = %v next=%v", numbers(p2), p2.NextPage)
	}
	beyond, _ := f.svc.ListPRs(ctx, f.pid, review.ListOptions{PerPage: 3, Page: 9})
	if len(beyond.PRs) != 0 || beyond.NextPage != nil {
		t.Fatalf("past the end = %v", numbers(beyond))
	}
}

func TestListPRsIsCachedPerFolderServedStaleAndRefreshedInTheBackground(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	ch, cancel := f.hub.Subscribe(f.pid)
	defer cancel()

	first, err := f.svc.ListPRs(ctx, f.pid, review.ListOptions{})
	if err != nil || first.Stale || first.FetchedAt == "" || len(first.PRs) != 2 {
		t.Fatalf("first = %+v %v", first, err)
	}
	calls := len(f.gh.Calls())
	// Within 60 s: answered from the cache, no gh call, not stale.
	f.now = f.now.Add(30 * time.Second)
	again, _ := f.svc.ListPRs(ctx, f.pid, review.ListOptions{})
	if again.Stale || again.FetchedAt != first.FetchedAt || len(f.gh.Calls()) != calls {
		t.Fatalf("a fresh cache hit called gh: stale=%v calls %d -> %d", again.Stale, calls, len(f.gh.Calls()))
	}

	// The pull request list changes on the host; the cached answer does not.
	f.gh.Retitle(t, 1, "Renamed on the host", "b")
	f.now = f.now.Add(40 * time.Second) // 70 s after the fetch
	stale, _ := f.svc.ListPRs(ctx, f.pid, review.ListOptions{})
	if !stale.Stale || stale.FetchedAt != first.FetchedAt {
		t.Fatalf("stale = %v fetched_at %s (first %s)", stale.Stale, stale.FetchedAt, first.FetchedAt)
	}
	for _, r := range stale.PRs {
		if r.Number == 1 && r.Title == "Renamed on the host" {
			t.Fatal("the stale answer already has the new title: it was not served from the cache")
		}
	}
	// The background refresh announces itself with the folder.
	deadline := time.After(10 * time.Second)
	for done := false; !done; {
		select {
		case ev := <-ch:
			if ev.Type != review.EventListUpdated {
				continue
			}
			var p struct {
				Folder string `json:"folder"`
			}
			if err := json.Unmarshal(ev.Data, &p); err != nil || p.Folder != "repo" {
				t.Fatalf("event = %s %v", ev.Data, err)
			}
			done = true
		case <-deadline:
			t.Fatal("no review.list_updated event")
		}
	}
	fresh, _ := f.svc.ListPRs(ctx, f.pid, review.ListOptions{})
	if fresh.Stale || fresh.FetchedAt == first.FetchedAt {
		t.Fatalf("after the refresh: stale=%v fetched_at %s", fresh.Stale, fresh.FetchedAt)
	}
	found := false
	for _, r := range fresh.PRs {
		found = found || r.Number == 1 && r.Title == "Renamed on the host"
	}
	if !found {
		t.Fatal("the refreshed list lacks the new title")
	}

	// ?refresh=1 forces a fetch now.
	n := countCalls(f, "pr list")
	f.gh.Retitle(t, 1, "Forced", "b")
	forced, _ := f.svc.ListPRs(ctx, f.pid, review.ListOptions{Refresh: true})
	if countCalls(f, "pr list") == n || forced.Stale {
		t.Fatal("refresh=1 did not call the host")
	}
	for _, r := range forced.PRs {
		if r.Number == 1 && r.Title != "Forced" {
			t.Fatalf("title = %q", r.Title)
		}
	}
}

func TestListPRsOnAnEnterpriseHostPassesTheHostThrough(t *testing.T) {
	f := newFixture(t)
	const host = "ghe.example.com"
	f.gh.Enterprise(t, f.repo, host)
	// A GH_HOST left in the environment for another host must not win.
	t.Setenv("GH_HOST", "github.com")
	ctx := context.Background()

	list, err := f.svc.ListPRs(ctx, f.pid, review.ListOptions{})
	if err != nil || !list.Available || list.Hostname != host || list.Repo != "acme/widgets" || len(list.PRs) != 2 {
		t.Fatalf("enterprise list = %+v %v", list, err)
	}
	if !strings.Contains(f.gh.LastEnv(), `GH_HOST="`+host+`"`) {
		t.Fatalf("gh did not get GH_HOST=%s:\n%s", host, f.gh.LastEnv())
	}
	if list.PRs[0].URL != "https://"+host+"/acme/widgets/pull/2" {
		t.Fatalf("url = %s", list.PRs[0].URL)
	}
	sawUser := false
	for _, c := range f.gh.Calls() {
		if strings.HasPrefix(c, "api user") {
			sawUser = true
			if !strings.Contains(c, "--hostname "+host) {
				t.Fatalf("api call without the host: %q", c)
			}
		}
	}
	if !sawUser {
		t.Fatal("the signed-in user was not looked up")
	}

	// Opening by the enterprise URL works; the github.com URL of the same repo does not match.
	v, _, err := f.svc.Open(ctx, f.pid, review.OpenRequest{URL: "https://" + host + "/acme/widgets/pull/1"})
	if err != nil || v.Repo != "acme/widgets" || v.Number != 1 {
		t.Fatalf("open by URL = %+v %v", v, err)
	}
	if _, _, err := f.svc.Open(ctx, f.pid, review.OpenRequest{URL: "https://github.com/acme/widgets/pull/2"}); err == nil || !strings.Contains(err.Error(), "repo_mismatch") {
		t.Fatalf("a pull request URL on another host = %v", err)
	}

	// Submit posts through `gh api --hostname`.
	if _, err := f.svc.CreateComment(ctx, f.pid, v.ID, review.CommentInput{Body: "general note"}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Submit(ctx, f.pid, v.ID, review.SubmitRequest{Verdict: "comment"}); err != nil {
		t.Fatalf("submit on an enterprise host: %v", err)
	}
	if len(f.gh.Posts()) != 1 {
		t.Fatalf("posts = %d", len(f.gh.Posts()))
	}
	last := f.gh.Calls()[len(f.gh.Calls())-1]
	if !strings.Contains(last, "--method POST") || !strings.Contains(last, "--hostname "+host) {
		t.Fatalf("post call = %q", last)
	}
}

func TestListPRsWithoutAHostRemoteLeavesGHHostAlone(t *testing.T) {
	// The fixture's origin is a local path: no host to derive, so the user's GH_HOST stays.
	f := newFixture(t)
	t.Setenv("GH_HOST", "ghe.corp.example")
	if _, err := f.svc.ListPRs(context.Background(), f.pid, review.ListOptions{}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(f.gh.LastEnv(), `GH_HOST="ghe.corp.example"`) {
		t.Fatalf("GH_HOST was replaced:\n%s", f.gh.LastEnv())
	}
}
