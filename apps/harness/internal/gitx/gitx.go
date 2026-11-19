// Package gitx runs git for the PR review feature: refs, fetches, worktrees and
// the object queries behind the diff. Every call passes arguments as an argv
// (never through a shell), so paths with spaces, Cyrillic or leading dashes are
// safe; paths that come from a diff are passed after `--` with literal
// pathspecs. The child environment is the harness allow-list (no provider
// keys, no GH_* tokens), plus settings that make git non-interactive.
package gitx

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/childenv"
)

var (
	binMu sync.Mutex
	bin   string
)

// SetBinary pins the git executable (absolute path). Tests that restrict PATH
// resolve git first and pin it here.
func SetBinary(path string) {
	binMu.Lock()
	bin = path
	binMu.Unlock()
}

func gitBinary() (string, error) {
	binMu.Lock()
	defer binMu.Unlock()
	if bin != "" {
		return bin, nil
	}
	p, err := exec.LookPath("git")
	if err != nil {
		return "", ErrNoGit
	}
	return p, nil
}

// ErrNoGit says the git executable was not found.
var ErrNoGit = errors.New("git is not installed or not on PATH")

// Error is a failed git command; Stderr is trimmed and capped.
type Error struct {
	Args   []string
	Stderr string
	Err    error
}

func (e *Error) Error() string {
	msg := strings.TrimSpace(e.Stderr)
	if msg == "" {
		msg = e.Err.Error()
	}
	return "git " + firstWord(e.Args) + ": " + msg
}

func (e *Error) Unwrap() error { return e.Err }

func firstWord(args []string) string {
	for _, a := range args {
		if !strings.HasPrefix(a, "-") {
			return a
		}
	}
	return ""
}

// DefaultTimeout bounds a command that has no deadline of its own.
const DefaultTimeout = 2 * time.Minute

// MaxOutput caps what Run keeps of stdout.
const MaxOutput = 64 << 20

// safeConfig is set on every git call the harness makes, so that a
// repository's own config (.git/config, which an agent's shell command can
// still write) never makes the harness run a program: no file-system
// monitor, no hooks (core.hooksPath points at a path that holds none, for
// every command, including a checkout the person asked for), no pager, no
// password prompt program, no ext:: transport. External diff drivers and
// text conversion are switched off per command (hardenArgs). Left as
// configured, on purpose: core.sshCommand and credential.helper, which a
// person's global config needs for fetches to authenticate; the system and
// global config are read as usual.
var safeConfig = [][2]string{
	{"core.fsmonitor", "false"},
	{"core.hooksPath", os.DevNull},
	{"core.pager", "cat"},
	{"core.askPass", ""},
	{"protocol.ext.allow", "never"},
}

// Env is the environment of every git child. It carries safeConfig as
// GIT_CONFIG_* variables too (git 2.31+), so a git process that git or
// another tool starts gets it as well.
func Env() []string {
	env := childenv.Build(os.Environ(), nil)
	env = append(env,
		"GIT_TERMINAL_PROMPT=0", "GIT_OPTIONAL_LOCKS=0", "GIT_PAGER=cat", "GIT_EDITOR=true",
		"LC_ALL=C.UTF-8", "LANG=C.UTF-8", fmt.Sprintf("GIT_CONFIG_COUNT=%d", len(safeConfig)))
	for i, kv := range safeConfig {
		env = append(env, fmt.Sprintf("GIT_CONFIG_KEY_%d=%s", i, kv[0]), fmt.Sprintf("GIT_CONFIG_VALUE_%d=%s", i, kv[1]))
	}
	return env
}

// hardenArgs is the full argv after `git`: dir, safeConfig as -c options, the
// fixed flags, and for the commands that can show a diff, no external diff
// program and no text conversion.
func hardenArgs(dir string, args []string) []string {
	full := []string{"-C", dir}
	for _, kv := range safeConfig {
		full = append(full, "-c", kv[0]+"="+kv[1])
	}
	full = append(full, "-c", "core.quotepath=off", "--literal-pathspecs")
	if len(args) > 0 {
		switch args[0] {
		case "diff", "log", "show":
			full = append(full, args[0], "--no-ext-diff", "--no-textconv")
			return append(full, args[1:]...)
		}
	}
	return append(full, args...)
}

// Run runs `git -C dir <args>` and returns stdout. Safe flags are always set:
// no quoted paths, literal pathspecs, no external diff or text conversion,
// and no program a repository's config or hooks name (safeConfig).
func Run(ctx context.Context, dir string, args ...string) ([]byte, error) {
	return RunIn(ctx, dir, nil, args...)
}

// RunIn is Run with stdin.
func RunIn(ctx context.Context, dir string, stdin io.Reader, args ...string) ([]byte, error) {
	b, err := gitBinary()
	if err != nil {
		return nil, err
	}
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, DefaultTimeout)
		defer cancel()
	}
	cmd := exec.CommandContext(ctx, b, hardenArgs(dir, args)...)
	cmd.Env = Env()
	cmd.Stdin = stdin
	var out bytes.Buffer
	var errb limited
	errb.max = 8 << 10
	cmd.Stdout = &limitedBuf{buf: &out, max: MaxOutput}
	cmd.Stderr = &errb
	if err := cmd.Run(); err != nil {
		return out.Bytes(), &Error{Args: args, Stderr: errb.String(), Err: err}
	}
	return out.Bytes(), nil
}

type limitedBuf struct {
	buf *bytes.Buffer
	max int
}

func (l *limitedBuf) Write(p []byte) (int, error) {
	if l.buf.Len()+len(p) > l.max {
		return 0, errors.New("git output too large")
	}
	return l.buf.Write(p)
}

type limited struct {
	bytes.Buffer
	max int
}

func (l *limited) Write(p []byte) (int, error) {
	if l.Len() < l.max {
		room := l.max - l.Len()
		if len(p) > room {
			l.Buffer.Write(p[:room])
		} else {
			l.Buffer.Write(p)
		}
	}
	return len(p), nil
}

func (l *limited) String() string { return l.Buffer.String() }

// IsRepo reports whether dir is inside a git work tree (or a bare repository).
func IsRepo(ctx context.Context, dir string) bool {
	out, err := Run(ctx, dir, "rev-parse", "--is-inside-work-tree")
	return err == nil && strings.TrimSpace(string(out)) == "true"
}

// TopLevel is the root of the work tree containing dir.
func TopLevel(ctx context.Context, dir string) (string, error) {
	out, err := Run(ctx, dir, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", err
	}
	return strings.TrimRight(string(out), "\r\n"), nil
}

// ValidRefName reports whether s is acceptable as a ref or revision typed by a
// user: non-empty, no leading dash, no control characters or spaces.
func ValidRefName(s string) bool {
	if s == "" || strings.HasPrefix(s, "-") || len(s) > 255 {
		return false
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f || r == ' ' {
			return false
		}
	}
	return !strings.Contains(s, "..")
}

// Resolve turns a ref or revision into a full commit id.
func Resolve(ctx context.Context, dir, rev string) (string, error) {
	if !ValidRefName(rev) {
		return "", fmt.Errorf("invalid revision %q", rev)
	}
	out, err := Run(ctx, dir, "rev-parse", "--verify", "--quiet", "--end-of-options", rev+"^{commit}")
	if err != nil {
		return "", fmt.Errorf("unknown revision %q", rev)
	}
	return strings.TrimSpace(string(out)), nil
}

// MergeBase is the best common ancestor of a and b; when they share none it is a.
func MergeBase(ctx context.Context, dir, a, b string) (string, error) {
	out, err := Run(ctx, dir, "merge-base", a, b)
	if err != nil {
		var ge *Error
		if errors.As(err, &ge) {
			// No common ancestor: diff against a itself.
			return a, nil
		}
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// IsAncestor reports whether a is an ancestor of b.
func IsAncestor(ctx context.Context, dir, a, b string) bool {
	_, err := Run(ctx, dir, "merge-base", "--is-ancestor", a, b)
	return err == nil
}

// CommitSubjects lists "sha subject" pairs of base..head, newest first, capped.
type Commit struct {
	SHA     string `json:"sha"`
	Subject string `json:"subject"`
	Author  string `json:"author"`
	Date    string `json:"date"`
}

func Commits(ctx context.Context, dir, base, head string, limit int) ([]Commit, error) {
	out, err := Run(ctx, dir, "log", "-z", fmt.Sprintf("--max-count=%d", limit),
		"--format=%H%x1f%s%x1f%an%x1f%aI", base+".."+head, "--")
	if err != nil {
		return nil, err
	}
	var res []Commit
	for _, rec := range strings.Split(string(out), "\x00") {
		rec = strings.TrimLeft(rec, "\n")
		if rec == "" {
			continue
		}
		p := strings.Split(rec, "\x1f")
		if len(p) < 4 {
			continue
		}
		res = append(res, Commit{SHA: p[0], Subject: p[1], Author: p[2], Date: p[3]})
	}
	return res, nil
}

// UpdateRef points ref at commit.
func UpdateRef(ctx context.Context, dir, ref, commit string) error {
	_, err := Run(ctx, dir, "update-ref", ref, commit)
	return err
}

// DeleteRefs removes every ref under prefix.
func DeleteRefs(ctx context.Context, dir, prefix string) {
	out, err := Run(ctx, dir, "for-each-ref", "--format=%(refname)", prefix)
	if err != nil {
		return
	}
	for _, r := range strings.Fields(string(out)) {
		_, _ = Run(ctx, dir, "update-ref", "-d", r)
	}
}

// Fetch runs `git fetch --no-tags <remote> <refspecs>`.
func Fetch(ctx context.Context, dir, remote string, refspecs ...string) error {
	args := append([]string{"fetch", "--no-tags", "--quiet", "--end-of-options", remote}, refspecs...)
	_, err := Run(ctx, dir, args...)
	return err
}

// Remotes lists the remote names and their fetch URLs.
func Remotes(ctx context.Context, dir string) (map[string]string, error) {
	out, err := Run(ctx, dir, "remote", "-v")
	if err != nil {
		return nil, err
	}
	res := map[string]string{}
	for _, line := range strings.Split(string(out), "\n") {
		// "name<TAB>url (fetch)": the url may contain spaces.
		name, rest, ok := strings.Cut(line, "\t")
		if ok && strings.HasSuffix(rest, " (fetch)") {
			res[name] = strings.TrimSuffix(rest, " (fetch)")
		}
	}
	return res, nil
}

// WorktreeAdd checks commit out detached into path (which must not exist).
func WorktreeAdd(ctx context.Context, repo, path, commit string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	_, err := Run(ctx, repo, "worktree", "add", "--detach", "--force", "--end-of-options", path, commit)
	return err
}

// WorktreeCheckout moves an existing review worktree to commit (detached).
func WorktreeCheckout(ctx context.Context, path, commit string) error {
	_, err := Run(ctx, path, "checkout", "--detach", "--force", commit, "--")
	return err
}

// WorktreeRemove removes a worktree and its administrative files. It falls back
// to deleting the directory and pruning when git no longer knows it.
func WorktreeRemove(ctx context.Context, repo, path string) error {
	_, err := Run(ctx, repo, "worktree", "remove", "--force", "--end-of-options", path)
	if err == nil {
		return nil
	}
	if rmErr := os.RemoveAll(path); rmErr != nil {
		return rmErr
	}
	_, _ = Run(ctx, repo, "worktree", "prune")
	return nil
}

// HeadBranch returns the short checked-out branch name, or "" when HEAD is detached.
func HeadBranch(ctx context.Context, repo string) (string, error) {
	out, err := Run(ctx, repo, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		return "", err
	}
	branch := strings.TrimSpace(string(out))
	if branch == "HEAD" {
		return "", nil
	}
	return branch, nil
}

// HeadCommit resolves HEAD to a full commit SHA.
func HeadCommit(ctx context.Context, repo string) (string, error) {
	out, err := Run(ctx, repo, "rev-parse", "--verify", "HEAD")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// WorktreeAddBranch creates a new branch at startPoint (defaulting to HEAD) checked out in path.
func WorktreeAddBranch(ctx context.Context, repo, path, branch, startPoint string) error {
	if !ValidRefName(branch) {
		return fmt.Errorf("invalid branch name %q", branch)
	}
	if startPoint == "" {
		startPoint = "HEAD"
	} else if !ValidRefName(startPoint) {
		return fmt.Errorf("invalid base revision %q", startPoint)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	_, err := Run(ctx, repo, "worktree", "add", "-b", branch, "--end-of-options", path, startPoint)
	return err
}

// CarryWorkingTreeChanges copies tracked (staged + unstaged relative to HEAD) and untracked
// non-ignored files from srcRepo into dstWorktree without mutating srcRepo.
func CarryWorkingTreeChanges(ctx context.Context, srcRepo, dstWorktree string) error {
	diff, err := Run(ctx, srcRepo, "diff", "--binary", "HEAD", "--")
	if err != nil {
		return err
	}
	if len(diff) > 0 {
		if _, err := RunIn(ctx, dstWorktree, bytes.NewReader(diff), "apply", "--whitespace=nowarn", "-"); err != nil {
			return err
		}
	}
	untracked, err := Run(ctx, srcRepo, "ls-files", "--others", "--exclude-standard", "-z")
	if err != nil {
		return err
	}
	for _, raw := range strings.Split(string(untracked), "\x00") {
		if raw == "" {
			continue
		}
		rel := filepath.FromSlash(raw)
		if filepath.IsAbs(rel) || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || rel == ".." {
			continue
		}
		srcPath := filepath.Join(srcRepo, rel)
		dstPath := filepath.Join(dstWorktree, rel)
		info, err := os.Lstat(srcPath)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(dstPath), 0o755); err != nil {
			return err
		}
		data, err := os.ReadFile(srcPath)
		if err != nil {
			return err
		}
		if err := os.WriteFile(dstPath, data, info.Mode().Perm()); err != nil {
			return err
		}
	}
	return nil
}
