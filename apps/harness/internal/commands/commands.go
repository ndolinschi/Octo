// Package commands runs a project's named commands (decision 68) on the
// user's request: the project's `commands` setting names them, POST
// …/commands/{name}/run starts one in the project's folder or in a review's
// worktree, the output streams as events and the last of it is kept.
//
// Safety, tested: a run is started only by this package's HTTP route. No agent
// package imports this one (go list -deps over every agent-side package), no
// tool or MCP route can start a run, and the harness's own approval flow does
// not apply to it: the command is the user's own action, also in a supervised
// project.
package commands

import (
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
	"unicode/utf8"

	"github.com/ndolinschi/Octo/apps/harness/internal/childenv"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/proctree"
	"github.com/ndolinschi/Octo/apps/harness/internal/projcfg"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// Project events.
const (
	// EventStarted carries { run } (a projectstore.CommandRun).
	EventStarted = "command.started"
	// EventOutput carries { run_id, stream: "stdout"|"stderr", text }: a chunk of output (at most 16 KiB, whole UTF-8 characters).
	EventOutput = "command.output"
	// EventFinished carries { run_id, exit_code, duration_ms, status, name, review_id? }.
	EventFinished = "command.finished"
)

// Limits.
const (
	// MaxConcurrent is how many runs a project may have at once.
	MaxConcurrent = 4
	// MaxOutputBytes caps the output of one run; past it the rest is dropped after a marker.
	MaxOutputBytes = 5 << 20
	// TailBytes is how much of the end of the output a run keeps.
	TailBytes = 64 << 10

	chunkBytes = 16 << 10
	flushEvery = 50 * time.Millisecond
	keepRuns   = 50
)

// TruncationMarker is appended to the output when it reaches MaxOutputBytes.
const TruncationMarker = "\n[output truncated: the 5 MB limit was reached; the rest was dropped]\n"

// Kind classifies an Error for the HTTP layer.
type Kind int

const (
	KindInvalid Kind = iota + 1
	KindNotFound
	KindConflict
)

// Error is a caller-visible failure with a stable machine code.
type Error struct {
	Kind    Kind
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func invalid(code, format string, args ...any) *Error {
	return &Error{Kind: KindInvalid, Code: code, Message: fmt.Sprintf(format, args...)}
}
func notFound(code, what string) *Error {
	return &Error{Kind: KindNotFound, Code: code, Message: what + " not found"}
}
func conflict(code, format string, args ...any) *Error {
	return &Error{Kind: KindConflict, Code: code, Message: fmt.Sprintf(format, args...)}
}

// Options configure New.
type Options struct {
	// StopGrace is how long Stop waits after SIGTERM before it kills the process group (default 3 s).
	StopGrace time.Duration
	// Now overrides the clock (tests).
	Now func() time.Time
	// Environ is the environment the commands' own is built from (default os.Environ); the
	// allow-list of childenv is applied to it either way.
	Environ func() []string
	// Shell is the bash to run (default: the bash found on PATH when a run starts).
	Shell string
	// Children records each run's process so a later start can stop what a crashed harness left (nil: not recorded).
	Children *proctree.Ledger
}

// Service starts and tracks the command runs of every project.
type Service struct {
	store   *projectstore.Store
	hub     *events.Hub
	grace   time.Duration
	now     func() time.Time
	environ func() []string
	shell   string
	ledger  *proctree.Ledger

	mu     sync.Mutex
	active map[string]*run
}

// New returns the service.
func New(store *projectstore.Store, hub *events.Hub, o Options) *Service {
	s := &Service{store: store, hub: hub, grace: o.StopGrace, now: o.Now, environ: o.Environ, shell: o.Shell, ledger: o.Children, active: map[string]*run{}}
	if s.environ == nil {
		s.environ = os.Environ
	}
	if s.shell == "" {
		s.shell = "bash"
	}
	if s.grace <= 0 {
		s.grace = 3 * time.Second
	}
	if s.now == nil {
		s.now = time.Now
	}
	return s
}

func (s *Service) db(ctx context.Context, pid string) (*projectstore.DB, error) {
	db, err := s.store.Get(ctx, pid)
	if errors.Is(err, projectstore.ErrNotFound) {
		return nil, notFound("not_found", "project")
	}
	var ne *projectstore.NewerSchemaError
	if errors.As(err, &ne) {
		return nil, conflict("newer_schema", "%s", ne.Error())
	}
	return db, err
}

// Recover settles the runs a previous harness process left "running": that
// process is gone, so they end as errors. Call it once at start.
func (s *Service) Recover(ctx context.Context) {
	ids, err := s.store.IDs(ctx)
	if err != nil {
		return
	}
	for _, id := range ids {
		db, err := s.store.Get(ctx, id)
		if err != nil {
			continue
		}
		if rows, err := db.Runs(ctx, "", 1000); err == nil {
			s.markInterrupted(ctx, db, id, rows)
		}
	}
}

// resolveDir picks the directory a command runs in. Without a review: the
// project's first folder, a folder named by the label in cwd, or a path
// relative to the first folder. With a review: the review's worktree, or a
// path relative to it.
func resolveDir(ctx context.Context, db *projectstore.DB, cmd projcfg.Command, reviewID string) (dir string, err error) {
	var base string
	label := ""
	if reviewID != "" {
		r, err := db.Review(ctx, reviewID)
		if errors.Is(err, projectstore.ErrNotFound) {
			return "", notFound("review_not_found", "review")
		}
		if err != nil {
			return "", err
		}
		if r.State != projectstore.ReviewOpen {
			return "", conflict("review_closed", "the review is closed; reopen it to run commands in it")
		}
		if fi, err := os.Stat(r.WorktreePath); r.WorktreePath == "" || err != nil || !fi.IsDir() {
			return "", conflict("worktree_missing", "the review's worktree is gone; open the review again")
		}
		base, label = r.WorktreePath, r.Folder
		if cmd.Cwd == "" || cmd.Cwd == label {
			return base, nil
		}
	} else {
		folders, err := db.Folders(ctx)
		if err != nil {
			return "", err
		}
		if len(folders) == 0 {
			return "", conflict("no_folder", "the project has no folder to run the command in")
		}
		base = folders[0].Path
		if cmd.Cwd == "" {
			return base, nil
		}
		for _, f := range folders {
			if f.Label == cmd.Cwd {
				return f.Path, nil
			}
		}
	}
	rel := filepath.FromSlash(strings.ReplaceAll(cmd.Cwd, "\\", "/"))
	target := filepath.Join(base, rel)
	realBase, err1 := filepath.EvalSymlinks(base)
	realTarget, err2 := filepath.EvalSymlinks(target)
	if err1 != nil || err2 != nil {
		return "", invalid("invalid_cwd", "the directory %q does not exist", cmd.Cwd)
	}
	if relp, err := filepath.Rel(realBase, realTarget); err != nil || relp == ".." || strings.HasPrefix(relp, ".."+string(filepath.Separator)) {
		return "", invalid("invalid_cwd", "the directory %q is outside the folder", cmd.Cwd)
	}
	if fi, err := os.Stat(realTarget); err != nil || !fi.IsDir() {
		return "", invalid("invalid_cwd", "%q is not a directory", cmd.Cwd)
	}
	return target, nil
}

// run is one running command.
type run struct {
	svc  *Service
	pid  string
	id   string
	cmd  *exec.Cmd
	done chan struct{}

	mu            sync.Mutex
	row           projectstore.CommandRun
	pend          [2][]byte // stdout, stderr: not yet sent as events
	tail          []byte
	total         int64
	truncated     bool
	stopRequested bool
}

const (
	stdout = 0
	stderr = 1
)

var streamNames = [2]string{"stdout", "stderr"}

// Start runs the project's command `name` (case-insensitive) in the project's
// folder, or in the worktree of review reviewID. It returns at once with the
// run; the output follows as events. Nothing but the user's HTTP call gets here.
func (s *Service) Start(ctx context.Context, pid, name, reviewID string) (projectstore.CommandRun, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return projectstore.CommandRun{}, err
	}
	raw, _, err := db.Setting(ctx, projectstore.SettingCommands)
	if err != nil {
		return projectstore.CommandRun{}, err
	}
	cmdDef, ok := projcfg.Find(projcfg.ParseCommands(raw), name)
	if !ok {
		return projectstore.CommandRun{}, notFound("command_not_found", fmt.Sprintf("command %q", name))
	}
	dir, err := resolveDir(ctx, db, cmdDef, reviewID)
	if err != nil {
		return projectstore.CommandRun{}, err
	}
	return s.spawn(ctx, db, pid, cmdDef, dir, reviewID)
}

func (s *Service) spawn(ctx context.Context, db *projectstore.DB, pid string, cmdDef projcfg.Command, dir, reviewID string) (projectstore.CommandRun, error) {
	s.mu.Lock()
	running := 0
	for _, r := range s.active {
		if r.pid == pid {
			running++
		}
	}
	if running >= MaxConcurrent {
		s.mu.Unlock()
		return projectstore.CommandRun{}, conflict("too_many_runs", "this project already has %d commands running; stop one first", MaxConcurrent)
	}
	// Same environment rules as the shell tool: the allow-listed environment, bash -c.
	cmd := exec.Command(s.shell, "-c", cmdDef.Command)
	cmd.Dir = dir
	cmd.Env = childenv.Build(s.environ(), nil)
	setProcessGroup(cmd)
	outPipe, err1 := cmd.StdoutPipe()
	errPipe, err2 := cmd.StderrPipe()
	if err1 != nil || err2 != nil {
		s.mu.Unlock()
		return projectstore.CommandRun{}, conflict("start_failed", "could not open the command's output")
	}
	if err := cmd.Start(); err != nil {
		s.mu.Unlock()
		return projectstore.CommandRun{}, conflict("start_failed", "could not start the command: %v", err)
	}
	osPID := 0
	if cmd.Process != nil {
		osPID = cmd.Process.Pid
	}
	s.ledger.Add(osPID, "process", cmdDef.Name)
	id := projectstore.NewID("run")
	r := &run{svc: s, pid: pid, id: id, cmd: cmd, done: make(chan struct{})}
	r.row = projectstore.CommandRun{ID: id, Name: cmdDef.Name, Command: cmdDef.Command, PID: osPID, Cwd: dir,
		ReviewID: reviewID, Status: projectstore.RunRunning, StartedAt: projectstore.Stamp(s.now())}
	s.active[r.row.ID] = r
	s.mu.Unlock()

	if err := db.AddRun(ctx, r.row); err != nil {
		signalGroup(cmd, true)
		_ = cmd.Wait()
		s.ledger.Remove(osPID)
		s.mu.Lock()
		delete(s.active, r.row.ID)
		s.mu.Unlock()
		return projectstore.CommandRun{}, err
	}
	s.hub.Publish(pid, EventStarted, map[string]any{"run": r.row})
	// What Start answers is the run as it started (like the started event), taken before the output readers exist: a
	// command that ends at once must not make the answer say "finished" (or have a half-built tail).
	started := r.snapshot(false)

	var readers sync.WaitGroup
	readers.Add(2)
	go func() { defer readers.Done(); r.pump(stdout, outPipe) }()
	go func() { defer readers.Done(); r.pump(stderr, errPipe) }()
	stopFlush := make(chan struct{})
	go r.flusher(stopFlush)
	go func() {
		readers.Wait()
		waitErr := cmd.Wait()
		s.ledger.Remove(osPID)
		close(stopFlush)
		r.finish(db, waitErr)
	}()
	return started, nil
}

// pump copies one stream of the process into pending output.
func (r *run) pump(stream int, rd io.Reader) {
	buf := make([]byte, 8<<10)
	for {
		n, err := rd.Read(buf)
		if n > 0 {
			r.add(stream, buf[:n])
		}
		if err != nil {
			return
		}
	}
}

// add accounts a chunk, keeps the tail and queues it for the next event. Past
// MaxOutputBytes it queues the marker once and drops everything after it.
func (r *run) add(stream int, p []byte) {
	r.mu.Lock()
	if r.truncated {
		r.mu.Unlock()
		return
	}
	room := int64(MaxOutputBytes) - r.total
	marker := false
	if int64(len(p)) > room {
		p, marker = p[:room], true
	}
	r.total += int64(len(p))
	r.pend[stream] = append(r.pend[stream], p...)
	r.tail = appendTail(r.tail, p)
	if marker {
		r.truncated = true
		r.pend[stdout] = append(r.pend[stdout], TruncationMarker...)
		r.tail = appendTail(r.tail, []byte(TruncationMarker))
	}
	big := len(r.pend[stream]) >= chunkBytes
	r.mu.Unlock()
	if big || marker {
		r.flush(false)
	}
}

func appendTail(tail, p []byte) []byte {
	tail = append(tail, p...)
	if len(tail) > TailBytes {
		tail = append([]byte(nil), tail[len(tail)-TailBytes:]...)
	}
	return tail
}

func (r *run) flusher(stop <-chan struct{}) {
	t := time.NewTicker(flushEvery)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			r.flush(false)
		}
	}
}

type outChunk struct {
	stream int
	text   string
}

// flush sends the pending output as events of at most chunkBytes, cut at
// character boundaries; final also sends an incomplete trailing character.
func (r *run) flush(final bool) {
	r.mu.Lock()
	var out []outChunk
	for s := range r.pend {
		b := r.pend[s]
		if len(b) == 0 {
			continue
		}
		keep := []byte(nil)
		if !final {
			b, keep = splitComplete(b)
		}
		r.pend[s] = append([]byte(nil), keep...)
		for len(b) > 0 {
			cut := min(len(b), chunkBytes)
			for cut < len(b) && cut > 0 && !utf8.RuneStart(b[cut]) {
				cut--
			}
			if cut == 0 {
				cut = len(b)
			}
			out = append(out, outChunk{s, strings.ToValidUTF8(string(b[:cut]), "�")})
			b = b[cut:]
		}
	}
	r.mu.Unlock()
	for _, c := range out {
		r.svc.hub.Publish(r.pid, EventOutput, map[string]any{"run_id": r.id, "stream": streamNames[c.stream], "text": c.text})
	}
}

// splitComplete holds back an incomplete UTF-8 character at the end of b.
func splitComplete(b []byte) (emit, keep []byte) {
	for i := 1; i < utf8.UTFMax && i <= len(b); i++ {
		if utf8.RuneStart(b[len(b)-i]) {
			if !utf8.FullRune(b[len(b)-i:]) {
				return b[:len(b)-i], b[len(b)-i:]
			}
			break
		}
	}
	return b, nil
}

// finish records how the run ended (after every output byte was read).
func (r *run) finish(db *projectstore.DB, waitErr error) {
	r.flush(true)
	r.mu.Lock()
	end := r.svc.now()
	row := r.row
	row.PID = 0
	row.FinishedAt = projectstore.Stamp(end)
	if started, err := time.Parse("2006-01-02T15:04:05.000Z07:00", row.StartedAt); err == nil {
		row.DurationMS = end.Sub(started).Milliseconds()
	}
	code := -1
	if r.cmd.ProcessState != nil {
		code = r.cmd.ProcessState.ExitCode()
	}
	row.ExitCode = &code
	row.Status = projectstore.RunFinished
	switch {
	case r.stopRequested:
		row.Status = projectstore.RunStopped
	case waitErr != nil && r.cmd.ProcessState == nil:
		row.Status = projectstore.RunError
	}
	row.OutputBytes, row.Truncated = r.total, r.truncated
	row.Tail = strings.ToValidUTF8(string(r.tail), "\ufffd")
	r.row = row
	r.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = db.FinishRun(ctx, row)
	_ = db.TrimRuns(ctx, keepRuns)
	r.svc.mu.Lock()
	delete(r.svc.active, row.ID)
	r.svc.mu.Unlock()
	close(r.done)
	fields := map[string]any{"run_id": row.ID, "exit_code": code, "duration_ms": row.DurationMS, "status": row.Status, "name": row.Name}
	if row.ReviewID != "" {
		fields["review_id"] = row.ReviewID
	}
	r.svc.hub.Publish(r.pid, EventFinished, fields)
}

// snapshot is the run as it stands now; withTail adds the kept output.
func (r *run) snapshot(withTail bool) projectstore.CommandRun {
	r.mu.Lock()
	defer r.mu.Unlock()
	row := r.row
	if row.Status == projectstore.RunRunning {
		row.OutputBytes, row.Truncated = r.total, r.truncated
		if started, err := time.Parse("2006-01-02T15:04:05.000Z07:00", row.StartedAt); err == nil {
			row.DurationMS = r.svc.now().Sub(started).Milliseconds()
		}
	}
	if withTail {
		row.Tail = strings.ToValidUTF8(string(r.tail), "\ufffd")
	} else {
		row.Tail = ""
	}
	return row
}

func (s *Service) activeRun(pid, rid string) *run {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r := s.active[rid]; r != nil && r.pid == pid {
		return r
	}
	return nil
}

// markInterrupted settles runs the store says are running but this process does not know:
// the harness stopped while they ran.
func (s *Service) markInterrupted(ctx context.Context, db *projectstore.DB, pid string, rows []projectstore.CommandRun) {
	for i := range rows {
		if rows[i].Status != projectstore.RunRunning || s.activeRun(pid, rows[i].ID) != nil {
			continue
		}
		rows[i].Status = projectstore.RunError
		rows[i].FinishedAt = projectstore.Stamp(s.now())
		rows[i].Tail = "(the harness stopped while this command was running)"
		_ = db.FinishRun(ctx, rows[i])
		rows[i].Tail = ""
	}
}

// Runs lists the project's runs, newest first, without output; reviewID narrows to one review's.
func (s *Service) Runs(ctx context.Context, pid, reviewID string, limit int) ([]projectstore.CommandRun, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return nil, err
	}
	rows, err := db.Runs(ctx, reviewID, limit)
	if err != nil {
		return nil, err
	}
	s.markInterrupted(ctx, db, pid, rows)
	for i := range rows {
		if r := s.activeRun(pid, rows[i].ID); r != nil {
			rows[i] = r.snapshot(false)
		}
	}
	return rows, nil
}

// Get returns one run with the tail of its output.
func (s *Service) Get(ctx context.Context, pid, rid string) (projectstore.CommandRun, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return projectstore.CommandRun{}, err
	}
	if r := s.activeRun(pid, rid); r != nil {
		return r.snapshot(true), nil
	}
	row, err := db.Run(ctx, rid)
	if errors.Is(err, projectstore.ErrNotFound) {
		return row, notFound("not_found", "run")
	}
	if err != nil {
		return row, err
	}
	if row.Status == projectstore.RunRunning {
		rows := []projectstore.CommandRun{row}
		s.markInterrupted(ctx, db, pid, rows)
		return db.Run(ctx, rid)
	}
	return row, nil
}

// Stop ends a run: SIGTERM to its process group, SIGKILL after the grace
// period. It answers with the run once it has ended; a run that already ended is returned as it is.
func (s *Service) Stop(ctx context.Context, pid, rid string) (projectstore.CommandRun, error) {
	return s.StopWith(ctx, pid, rid, false)
}

// Shutdown ends every running command (the harness is stopping).
func (s *Service) Shutdown(ctx context.Context) {
	s.mu.Lock()
	runs := make([]*run, 0, len(s.active))
	for _, r := range s.active {
		runs = append(runs, r)
	}
	s.mu.Unlock()
	for _, r := range runs {
		r.mu.Lock()
		r.stopRequested = true
		r.mu.Unlock()
		signalGroup(r.cmd, true)
	}
	for _, r := range runs {
		select {
		case <-r.done:
		case <-ctx.Done():
			return
		}
	}
}
