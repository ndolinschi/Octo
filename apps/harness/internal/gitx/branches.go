package gitx

import (
	"context"
	"fmt"
	"strings"
	"sync"
)

// CurrentBranch is the checked-out branch ("" on a detached HEAD).
func CurrentBranch(ctx context.Context, dir string) string {
	out, err := Run(ctx, dir, "symbolic-ref", "--quiet", "--short", "HEAD")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// TrackingRemote is the remote the current branch tracks (branch.<name>.remote);
// an error when the branch tracks none or HEAD is detached.
func TrackingRemote(ctx context.Context, dir string) (string, error) {
	b := CurrentBranch(ctx, dir)
	if b == "" {
		return "", fmt.Errorf("detached HEAD")
	}
	out, err := Run(ctx, dir, "config", "--get", "branch."+b+".remote")
	if err != nil {
		return "", err
	}
	r := strings.TrimSpace(string(out))
	if r == "" || r == "." {
		return "", fmt.Errorf("no remote")
	}
	return r, nil
}

// Branch is a local branch with its distance from a base.
type Branch struct {
	Name    string `json:"name"`
	Current bool   `json:"current"`
	Ahead   int    `json:"ahead"`
	Behind  int    `json:"behind"`
	Commit  Commit `json:"commit"`
}

// MaxBranches caps LocalBranches.
const MaxBranches = 200

const branchCountWorkers = 8

// LocalBranches lists the local branches, the current one first, then by last
// commit date (newest first), with ahead/behind counts against base (any
// revision). truncated is true when there were more than MaxBranches.
func LocalBranches(ctx context.Context, dir, base string) (list []Branch, truncated bool, err error) {
	list, _, truncated, err = LocalBranchesChunk(ctx, dir, base, 0, MaxBranches)
	return list, truncated, err
}

// LocalBranchesChunk lists a chunk of local branches starting at offset (at most
// limit branches; limit <= 0 returns all remaining up to MaxBranches), computing
// ahead/behind counts against base only for the returned chunk.
func LocalBranchesChunk(ctx context.Context, dir, base string, offset, limit int) (list []Branch, total int, truncated bool, err error) {
	out, err := Run(ctx, dir, "for-each-ref", "--sort=-committerdate",
		"--format=%(refname:short)%1f%(objectname)%1f%(subject)%1f%(committerdate:iso-strict)", "refs/heads")
	if err != nil {
		return nil, 0, false, err
	}
	cur := CurrentBranch(ctx, dir)
	var current *Branch
	all := []Branch{}
	for _, rec := range strings.Split(string(out), "\n") {
		rec = strings.TrimLeft(rec, "\n")
		if rec == "" {
			continue
		}
		p := strings.Split(rec, "\x1f")
		if len(p) < 4 {
			continue
		}
		b := Branch{Name: p[0], Current: p[0] == cur, Commit: Commit{SHA: p[1], Subject: p[2], Date: p[3]}}
		if b.Current {
			c := b
			current = &c
			continue
		}
		all = append(all, b)
	}
	if current != nil {
		all = append([]Branch{*current}, all...)
	}
	if len(all) > MaxBranches {
		all, truncated = all[:MaxBranches], true
	}
	total = len(all)
	if offset < 0 {
		offset = 0
	}
	if offset >= total {
		return []Branch{}, total, truncated, nil
	}
	end := total
	if limit > 0 && offset+limit < end {
		end = offset + limit
	}
	list = make([]Branch, end-offset)
	copy(list, all[offset:end])

	if len(list) == 0 {
		return list, total, truncated, nil
	}
	workers := min(branchCountWorkers, len(list))
	jobs := make(chan int, len(list))
	for i := range list {
		jobs <- i
	}
	close(jobs)
	var wg sync.WaitGroup
	wg.Add(workers)
	for range workers {
		go func() {
			defer wg.Done()
			for i := range jobs {
				o, err := Run(ctx, dir, "rev-list", "--left-right", "--count", list[i].Commit.SHA+"..."+base, "--")
				if err != nil {
					continue
				}
				f := strings.Fields(string(o))
				if len(f) == 2 {
					_, _ = fmt.Sscan(f[0], &list[i].Ahead)
					_, _ = fmt.Sscan(f[1], &list[i].Behind)
				}
			}
		}()
	}
	wg.Wait()
	return list, total, truncated, nil
}

// DefaultBranch is the default branch of remote (from refs/remotes/<remote>/HEAD),
// else "main" or "master" when one exists locally; "" when none is found.
func DefaultBranch(ctx context.Context, dir, remote string) string {
	if remote != "" {
		if out, err := Run(ctx, dir, "symbolic-ref", "--quiet", "--short", "refs/remotes/"+remote+"/HEAD"); err == nil {
			return strings.TrimPrefix(strings.TrimSpace(string(out)), remote+"/")
		}
	}
	for _, n := range []string{"main", "master"} {
		if _, err := Run(ctx, dir, "rev-parse", "--verify", "--quiet", "refs/heads/"+n); err == nil {
			return n
		}
	}
	return ""
}
