package gitx

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

var (
	// ErrBranchNotFound: no local branch of that name.
	ErrBranchNotFound = errors.New("no local branch of that name")
	// ErrBranchExists: a branch to create exists already.
	ErrBranchExists = errors.New("a branch of that name exists already")
	// ErrInvalidBranchName: git does not accept the name as a branch.
	ErrInvalidBranchName = errors.New("not a valid branch name")
)

// ShortHead is HEAD's abbreviated commit ("" when the repository has no commit).
func ShortHead(ctx context.Context, dir string) string {
	out, err := Run(ctx, dir, "rev-parse", "--short", "--verify", "--quiet", "HEAD")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// BranchExists reports whether a local branch name exists.
func BranchExists(ctx context.Context, dir, name string) bool {
	_, err := Run(ctx, dir, "rev-parse", "--verify", "--quiet", "--end-of-options", "refs/heads/"+name)
	return err == nil
}

// ValidBranchName asks git whether name is a valid new branch name.
func ValidBranchName(ctx context.Context, dir, name string) bool {
	if !ValidRefName(name) {
		return false
	}
	_, err := Run(ctx, dir, "check-ref-format", "--branch", name)
	return err == nil
}

// DirtyFiles lists the tracked files with staged or unstaged changes (untracked files are not
// counted: `git switch` keeps them and refuses by itself when one would be overwritten).
func DirtyFiles(ctx context.Context, dir string) ([]string, error) {
	out, err := Run(ctx, dir, "status", "--porcelain=v1", "-z", "--untracked-files=no", "--ignore-submodules=dirty")
	if err != nil {
		return nil, err
	}
	files := []string{}
	recs := strings.Split(string(out), "\x00")
	for i := 0; i < len(recs); i++ {
		rec := recs[i]
		if len(rec) < 4 {
			continue
		}
		files = append(files, rec[3:])
		// A rename or copy is followed by its source path.
		if rec[0] == 'R' || rec[0] == 'C' {
			i++
		}
	}
	return files, nil
}

// SwitchBranch checks out a local branch in dir's work tree (`git switch`); with create it makes
// the branch from HEAD first (`git switch -c`). It never forces, stashes or discards: git's own
// refusal (a file that would be overwritten) is returned as an *Error.
func SwitchBranch(ctx context.Context, dir, name string, create bool) error {
	if create {
		if !ValidBranchName(ctx, dir, name) {
			return fmt.Errorf("%w: %q", ErrInvalidBranchName, name)
		}
		if BranchExists(ctx, dir, name) {
			return fmt.Errorf("%w: %q", ErrBranchExists, name)
		}
		_, err := Run(ctx, dir, "switch", "--quiet", "--no-track", "-c", name)
		return err
	}
	if !ValidRefName(name) || !BranchExists(ctx, dir, name) {
		return fmt.Errorf("%w: %q", ErrBranchNotFound, name)
	}
	_, err := Run(ctx, dir, "switch", "--quiet", "--no-guess", name)
	return err
}
