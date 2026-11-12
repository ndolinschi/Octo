package commands_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/ndolinschi/Octo/apps/harness/internal/commands"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/projcfg"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

type fixture struct {
	t      *testing.T
	svc    *commands.Service
	hub    *events.Hub
	db     *projectstore.DB
	pid    string
	folder string
	ch     <-chan events.Event
}

func newFixture(t *testing.T, cmds ...projcfg.Command) *fixture {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("bash")
	}
	store, err := projectstore.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	folder := t.TempDir()
	if r, err := filepath.EvalSymlinks(folder); err == nil {
		folder = r
	}
	db, err := store.Create(context.Background(), projectstore.NewProject{
		Name: "p", ModelsJSON: "{}", MaxDepth: 1, OrchestratorModel: "m",
		Folders: []projectstore.Folder{{Label: "app", Path: folder}, {Label: "lib", Path: t.TempDir()}},
	})
	if err != nil {
		t.Fatal(err)
	}
	hub := events.NewHub()
	f := &fixture{t: t, hub: hub, db: db, pid: db.ID(), folder: folder}
	f.svc = commands.New(store, hub, commands.Options{StopGrace: 300 * time.Millisecond})
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		f.svc.Shutdown(ctx)
	})
	f.setCommands(cmds...)
	ch, cancel := hub.Subscribe(db.ID())
	t.Cleanup(cancel)
	f.ch = ch
	return f
}

func (f *fixture) setCommands(cmds ...projcfg.Command) {
	f.t.Helper()
	b, _ := json.Marshal(cmds)
	if err := f.db.SetSetting(context.Background(), projectstore.SettingCommands, string(b)); err != nil {
		f.t.Fatal(err)
	}
}

type outcome struct {
	stdout, stderr string
	chunks         []string
	exit           int
	status         string
	durationMS     int64
}

// wait collects the output events of run until its command.finished arrives.
func (f *fixture) wait(runID string) outcome {
	f.t.Helper()
	var o outcome
	deadline := time.After(20 * time.Second)
	for {
		select {
		case ev := <-f.ch:
			var p struct {
				RunID      string `json:"run_id"`
				Stream     string `json:"stream"`
				Text       string `json:"text"`
				ExitCode   int    `json:"exit_code"`
				DurationMS int64  `json:"duration_ms"`
				Status     string `json:"status"`
			}
			if json.Unmarshal(ev.Data, &p) != nil || p.RunID != runID {
				continue
			}
			switch ev.Type {
			case commands.EventOutput:
				o.chunks = append(o.chunks, p.Text)
				if p.Stream == "stdout" {
					o.stdout += p.Text
				} else if p.Stream == "stderr" {
					o.stderr += p.Text
				} else {
					f.t.Fatalf("stream = %q", p.Stream)
				}
			case commands.EventFinished:
				o.exit, o.status, o.durationMS = p.ExitCode, p.Status, p.DurationMS
				return o
			}
		case <-deadline:
			f.t.Fatalf("run %s did not finish (stdout so far %d bytes)", runID, len(o.stdout))
		}
	}
}

func (f *fixture) start(name, review string) projectstore.CommandRun {
	f.t.Helper()
	run, err := f.svc.Start(context.Background(), f.pid, name, review)
	if err != nil {
		f.t.Fatalf("start %s: %v", name, err)
	}
	return run
}

func cmdErr(t *testing.T, err error) *commands.Error {
	t.Helper()
	ce, ok := err.(*commands.Error)
	if !ok {
		t.Fatalf("want *commands.Error, got %v", err)
	}
	return ce
}

func TestARunStreamsOutputReportsTheExitAndKeepsATail(t *testing.T) {
	f := newFixture(t, projcfg.Command{Name: "Mixed", Command: "echo hello; echo oops >&2; echo more; exit 3"})
	run := f.start("mixed", "") // names match case-insensitively
	if run.ID == "" || run.Status != "running" || run.Name != "Mixed" || run.Cwd != f.folder || run.ExitCode != nil {
		t.Fatalf("run = %+v", run)
	}
	o := f.wait(run.ID)
	if o.stdout != "hello\nmore\n" || o.stderr != "oops\n" || o.exit != 3 || o.status != "finished" || o.durationMS < 0 {
		t.Fatalf("outcome = %+v", o)
	}
	got, err := f.svc.Get(context.Background(), f.pid, run.ID)
	if err != nil || got.Status != "finished" || got.ExitCode == nil || *got.ExitCode != 3 || got.FinishedAt == "" ||
		!strings.Contains(got.Tail, "hello") || !strings.Contains(got.Tail, "oops") || got.OutputBytes != int64(len("hello\nmore\n")+len("oops\n")) {
		t.Fatalf("get = %+v %v", got, err)
	}
	list, err := f.svc.Runs(context.Background(), f.pid, "", 0)
	if err != nil || len(list) != 1 || list[0].ID != run.ID || list[0].Tail != "" {
		t.Fatalf("runs = %+v %v", list, err)
	}
	// It is stored: a new service over the same store sees it.
	if row, err := f.db.Run(context.Background(), run.ID); err != nil || row.Status != "finished" || row.Tail == "" {
		t.Fatalf("stored = %+v %v", row, err)
	}
	// And a success is exit 0.
	f.setCommands(projcfg.Command{Name: "ok", Command: "true"})
	if o := f.wait(f.start("ok", "").ID); o.exit != 0 || o.status != "finished" {
		t.Fatalf("true = %+v", o)
	}
}

func TestACommandGetsTheShellToolsEnvironmentAndTheProjectFolder(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "sk-must-not-leak")
	t.Setenv("GITHUB_TOKEN", "ghp-must-not-leak")
	t.Setenv("MY_SERVICE_PASSWORD", "hunter2")
	f := newFixture(t, projcfg.Command{Name: "env", Command: "env; echo CWD=$(pwd)"})
	o := f.wait(f.start("env", "").ID)
	if strings.Contains(o.stdout, "must-not-leak") || strings.Contains(o.stdout, "hunter2") || strings.Contains(o.stdout, "ANTHROPIC_API_KEY") {
		t.Fatalf("a secret reached the command:\n%s", o.stdout)
	}
	if !strings.Contains(o.stdout, "PATH=") || !strings.Contains(o.stdout, "CWD="+f.folder+"\n") {
		t.Fatalf("env / cwd:\n%s", o.stdout)
	}
}

func TestCwdIsAFolderLabelOrASubdirectoryAndNeverEscapes(t *testing.T) {
	f := newFixture(t)
	if err := os.MkdirAll(filepath.Join(f.folder, "web", "ui"), 0o755); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(f.folder, "escape")); err != nil {
		t.Fatal(err)
	}
	f.setCommands(
		projcfg.Command{Name: "sub", Command: "pwd", Cwd: "web/ui"},
		projcfg.Command{Name: "lib", Command: "pwd", Cwd: "lib"},
		projcfg.Command{Name: "missing", Command: "pwd", Cwd: "nope"},
		projcfg.Command{Name: "escape", Command: "pwd", Cwd: "escape"},
	)
	if o := f.wait(f.start("sub", "").ID); strings.TrimSpace(o.stdout) != filepath.Join(f.folder, "web", "ui") {
		t.Fatalf("sub cwd = %q", o.stdout)
	}
	libRun := f.start("lib", "")
	if o := f.wait(libRun.ID); strings.TrimSpace(o.stdout) == f.folder || !strings.HasPrefix(strings.TrimSpace(o.stdout), "/") {
		t.Fatalf("lib cwd = %q", o.stdout)
	}
	for _, name := range []string{"missing", "escape"} {
		_, err := f.svc.Start(context.Background(), f.pid, name, "")
		if ce := cmdErr(t, err); ce.Code != "invalid_cwd" || ce.Kind != commands.KindInvalid {
			t.Fatalf("%s: %v", name, err)
		}
	}
	if _, err := f.svc.Start(context.Background(), f.pid, "nope", ""); cmdErr(t, err).Code != "command_not_found" {
		t.Fatalf("unknown command: %v", err)
	}
	if _, err := f.svc.Start(context.Background(), "prj_nope", "x", ""); cmdErr(t, err).Code != "not_found" {
		t.Fatalf("unknown project: %v", err)
	}
}

func TestARunInAReviewWorktreeAndTheReviewsRunList(t *testing.T) {
	f := newFixture(t, projcfg.Command{Name: "where", Command: "pwd", Cwd: ""}, projcfg.Command{Name: "sub", Command: "pwd", Cwd: "pkg"})
	ctx := context.Background()
	worktree := t.TempDir()
	if r, err := filepath.EvalSymlinks(worktree); err == nil {
		worktree = r
	}
	if err := os.MkdirAll(filepath.Join(worktree, "pkg"), 0o755); err != nil {
		t.Fatal(err)
	}
	rv, err := f.db.CreateReview(ctx, projectstore.Review{Source: "local:a..b", Kind: "local", Folder: "app", Title: "t", WorktreePath: worktree})
	if err != nil {
		t.Fatal(err)
	}
	run := f.start("where", rv.ID)
	if run.ReviewID != rv.ID || run.Cwd != worktree {
		t.Fatalf("run = %+v", run)
	}
	if o := f.wait(run.ID); strings.TrimSpace(o.stdout) != worktree {
		t.Fatalf("ran in %q, want the worktree %q", o.stdout, worktree)
	}
	if o := f.wait(f.start("sub", rv.ID).ID); strings.TrimSpace(o.stdout) != filepath.Join(worktree, "pkg") {
		t.Fatalf("sub in the worktree = %q", o.stdout)
	}
	// The review's list has only its runs; the project's has all (one more, outside the review).
	f.wait(f.start("where", "").ID)
	mine, _ := f.svc.Runs(ctx, f.pid, rv.ID, 0)
	all, _ := f.svc.Runs(ctx, f.pid, "", 0)
	if len(mine) != 2 || len(all) != 3 {
		t.Fatalf("runs: review %d, all %d", len(mine), len(all))
	}

	if _, err := f.svc.Start(ctx, f.pid, "where", "rev_nope"); cmdErr(t, err).Code != "review_not_found" {
		t.Fatalf("unknown review: %v", err)
	}
	if err := os.RemoveAll(worktree); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Start(ctx, f.pid, "where", rv.ID); cmdErr(t, err).Code != "worktree_missing" {
		t.Fatalf("missing worktree: %v", err)
	}
	closed := projectstore.ReviewClosed
	if _, err := f.db.UpdateReview(ctx, rv.ID, projectstore.ReviewPatch{State: &closed}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Start(ctx, f.pid, "where", rv.ID); cmdErr(t, err).Code != "review_closed" {
		t.Fatalf("closed review: %v", err)
	}
}

func TestStopEndsTheWholeProcessGroupAndAtMostFourRunsAtOnce(t *testing.T) {
	f := newFixture(t,
		projcfg.Command{Name: "dev", Command: "sleep 300 & echo $! > child.pid; wait"},
		projcfg.Command{Name: "stubborn", Command: "trap '' TERM; echo ready; sleep 300 & wait"},
	)
	ctx := context.Background()
	a := f.start("dev", "")
	deadline := time.Now().Add(10 * time.Second)
	var child int
	for time.Now().Before(deadline) {
		if b, err := os.ReadFile(filepath.Join(f.folder, "child.pid")); err == nil && strings.TrimSpace(string(b)) != "" {
			_, _ = fmtSscan(strings.TrimSpace(string(b)), &child)
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if child == 0 || syscall.Kill(child, 0) != nil {
		t.Fatalf("the background child did not start (pid %d)", child)
	}

	// Four at once; the fifth is refused.
	runs := []projectstore.CommandRun{a, f.start("dev", ""), f.start("dev", ""), f.start("dev", "")}
	if _, err := f.svc.Start(ctx, f.pid, "dev", ""); cmdErr(t, err).Code != "too_many_runs" || cmdErr(t, err).Kind != commands.KindConflict {
		t.Fatalf("fifth run: %v", err)
	}
	if list, _ := f.svc.Runs(ctx, f.pid, "", 0); len(list) != 4 {
		t.Fatalf("runs = %d", len(list))
	}

	stopped, err := f.svc.Stop(ctx, f.pid, a.ID)
	if err != nil || stopped.Status != "stopped" || stopped.ExitCode == nil {
		t.Fatalf("stop = %+v %v", stopped, err)
	}
	// The child of the shell died with the group.
	gone := false
	for i := 0; i < 100 && !gone; i++ {
		gone = syscall.Kill(child, 0) != nil
		if !gone {
			time.Sleep(20 * time.Millisecond)
		}
	}
	if !gone {
		t.Fatal("the background child survived the stop")
	}
	// A slot is free again.
	extra := f.start("stubborn", "")
	for _, r := range runs[1:] {
		if _, err := f.svc.Stop(ctx, f.pid, r.ID); err != nil {
			t.Fatal(err)
		}
	}
	// A command that ignores SIGTERM is killed after the grace period.
	start := time.Now()
	st, err := f.svc.Stop(ctx, f.pid, extra.ID)
	if err != nil || st.Status != "stopped" || time.Since(start) > 4*time.Second {
		t.Fatalf("stubborn stop = %+v %v after %v", st, err, time.Since(start))
	}
	// Stopping a finished run is not an error.
	if again, err := f.svc.Stop(ctx, f.pid, extra.ID); err != nil || again.Status != "stopped" {
		t.Fatalf("stop twice = %+v %v", again, err)
	}
	if _, err := f.svc.Stop(ctx, f.pid, "run_nope"); cmdErr(t, err).Code != "not_found" {
		t.Fatal("unknown run")
	}
}

func TestOutputIsChunkedAtCharactersAndCappedAtFiveMegabytes(t *testing.T) {
	f := newFixture(t,
		projcfg.Command{Name: "utf8", Command: "yes 'ё' | head -c 60000"},
		projcfg.Command{Name: "big", Command: "head -c 6000000 /dev/zero | tr '\\0' 'a'"},
	)
	o := f.wait(f.start("utf8", "").ID)
	if len(o.stdout) != 60000 || strings.ContainsRune(o.stdout, utf8.RuneError) || !utf8.ValidString(o.stdout) {
		t.Fatalf("utf8 output: %d bytes, valid=%v", len(o.stdout), utf8.ValidString(o.stdout))
	}
	for _, c := range o.chunks {
		if len(c) > 16<<10 || !utf8.ValidString(c) {
			t.Fatalf("chunk of %d bytes, valid=%v", len(c), utf8.ValidString(c))
		}
	}
	if len(o.chunks) < 3 {
		t.Fatalf("60000 bytes arrived in %d chunks", len(o.chunks))
	}

	run := f.start("big", "")
	o = f.wait(run.ID)
	if !strings.HasSuffix(o.stdout, commands.TruncationMarker) || len(o.stdout) != commands.MaxOutputBytes+len(commands.TruncationMarker) {
		t.Fatalf("big output: %d bytes, marker at end = %v", len(o.stdout), strings.HasSuffix(o.stdout, commands.TruncationMarker))
	}
	for _, c := range o.chunks {
		if len(c) > 16<<10 {
			t.Fatalf("chunk of %d bytes", len(c))
		}
	}
	got, _ := f.svc.Get(context.Background(), f.pid, run.ID)
	if !got.Truncated || got.OutputBytes != commands.MaxOutputBytes || got.Status != "finished" || got.ExitCode == nil || *got.ExitCode != 0 ||
		!strings.HasSuffix(got.Tail, commands.TruncationMarker) || len(got.Tail) > commands.TailBytes {
		t.Fatalf("big run = truncated %v bytes %d status %s tail %d", got.Truncated, got.OutputBytes, got.Status, len(got.Tail))
	}
}

func TestARunTheHarnessLostIsSettledAsAnError(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	orphan := projectstore.CommandRun{ID: "run_orphan", Name: "x", Command: "sleep 1", Cwd: f.folder, Status: "running", StartedAt: projectstore.Now()}
	if err := f.db.AddRun(ctx, orphan); err != nil {
		t.Fatal(err)
	}
	got, err := f.svc.Get(ctx, f.pid, orphan.ID)
	if err != nil || got.Status != "error" || got.FinishedAt == "" {
		t.Fatalf("orphan = %+v %v", got, err)
	}
	orphan.ID = "run_orphan2"
	_ = f.db.AddRun(ctx, orphan)
	f.svc.Recover(ctx)
	if row, _ := f.db.Run(ctx, "run_orphan2"); row.Status != "error" {
		t.Fatalf("recover left %+v", row)
	}
}

func TestStartedEventCarriesTheRun(t *testing.T) {
	f := newFixture(t, projcfg.Command{Name: "x", Command: "true"})
	run := f.start("x", "")
	deadline := time.After(5 * time.Second)
	for {
		select {
		case ev := <-f.ch:
			if ev.Type == commands.EventStarted {
				var p struct {
					Run projectstore.CommandRun `json:"run"`
				}
				if err := json.Unmarshal(ev.Data, &p); err != nil || p.Run.ID != run.ID || p.Run.Name != "x" {
					t.Fatalf("started = %s", ev.Data)
				}
				f.wait(run.ID)
				return
			}
		case <-deadline:
			t.Fatal("no command.started")
		}
	}
}
