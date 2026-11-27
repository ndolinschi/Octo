package agentlogin_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/agentlogin"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/terminal"
)

// The agent "cc" is logged in when $CLAUDE_CONFIG_DIR/ok exists; its login
// command is a shell script given per test through the "script" login method.
const manifest = `{"name":"p","version":"1","agents":[
 {"id":"cc","label":"Claude Code","command":"sh","accounts":{"env":{"CLAUDE_CONFIG_DIR":"{dir}"}},
  "auth":{"probe":["sh","-c","test -f \"$CLAUDE_CONFIG_DIR/ok\""],"notLoggedInExit":[1],
   "login":[{"id":"script","label":"Script","args":["sh","-c","%SCRIPT%"]}]}},
 {"id":"plain","label":"Plain","command":"sh"}]}`

type fixture struct {
	reg  *plugins.Registry
	mgr  *terminal.Manager
	svc  *agentlogin.Service
	work string // folder of the account cc@work
	home string
}

func newFixture(t *testing.T, script string, opts agentlogin.Options) *fixture {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("uses sh")
	}
	data := t.TempDir()
	dir := filepath.Join(data, "plugins", "p")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	m := strings.ReplaceAll(manifest, "%SCRIPT%", strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(script))
	if err := os.WriteFile(filepath.Join(dir, plugins.ManifestName), []byte(m), 0o644); err != nil {
		t.Fatal(err)
	}
	f := &fixture{reg: plugins.Load(context.Background(), data, nil, nil), work: t.TempDir(), home: t.TempDir()}
	if errs := f.reg.SetAccounts([]plugins.AccountSpec{{Agent: "cc", ID: "work", Name: "Work", Dir: f.work, Owned: true}}, nil); len(errs) > 0 {
		t.Fatalf("accounts: %v", errs)
	}
	f.mgr = terminal.NewManager(terminal.Options{})
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = f.mgr.Shutdown(ctx)
	})
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	opts.Home = func() string { return f.home }
	f.svc = agentlogin.New(ctx, f.reg, f.mgr, opts)
	return f
}

func wantDone(t *testing.T, l *agentlogin.Login) {
	t.Helper()
	select {
	case <-l.Done():
	case <-time.After(15 * time.Second):
		t.Fatal("login did not finish")
	}
}

func states(ch <-chan string) []string {
	var out []string
	for {
		select {
		case s := <-ch:
			out = append(out, s)
		default:
			return out
		}
	}
}

func wantState(t *testing.T, ch <-chan string, want string) {
	t.Helper()
	deadline := time.After(15 * time.Second)
	for {
		select {
		case s := <-ch:
			if s == want {
				return
			}
		case <-deadline:
			t.Fatalf("no %q state", want)
		}
	}
}

func TestLoginRunsInTheAccountFolderAndRechecksAtExit(t *testing.T) {
	f := newFixture(t, `read x; pwd -P > "$CLAUDE_CONFIG_DIR/pwd"; touch "$CLAUDE_CONFIG_DIR/ok"; echo got $x`, agentlogin.Options{PollEvery: time.Hour})
	l, err := f.svc.Start(context.Background(), "cc@work", agentlogin.Request{Method: "script"})
	if err != nil {
		t.Fatal(err)
	}
	ch, release := l.Watch()
	defer release()
	if err := l.Session().WriteInput(context.Background(), []byte("hello\n")); err != nil {
		t.Fatal(err)
	}
	wantState(t, ch, agentlogin.StateOK)
	wantDone(t, l)
	pwd, err := os.ReadFile(filepath.Join(f.work, "pwd"))
	if err != nil {
		t.Fatal(err)
	}
	if want, _ := filepath.EvalSymlinks(f.work); strings.TrimSpace(string(pwd)) != want {
		t.Fatalf("login ran in %q, want %q", pwd, want)
	}
	if l.State() != agentlogin.StateOK {
		t.Fatalf("state = %q", l.State())
	}
	// The login is the account's: the base agent, with no folder variable, is still logged out.
	if a, _ := f.reg.Recheck(context.Background(), "cc"); a.LoggedIn == nil || *a.LoggedIn {
		t.Fatalf("base agent logged_in = %v", a.LoggedIn)
	}
}

func TestLoginsStayOutOfProjectsAndDefaultAccountRunsInHome(t *testing.T) {
	f := newFixture(t, `sleep 30`, agentlogin.Options{PollEvery: time.Hour})
	l, err := f.svc.Start(context.Background(), "cc", agentlogin.Request{Method: "script"})
	if err != nil {
		t.Fatal(err)
	}
	if got := f.mgr.ListProject(agentlogin.Project); len(got) != 1 || got[0].ID != l.ID || got[0].Spec.Dir != f.home {
		t.Fatalf("login sessions = %+v", got)
	}
	if got := f.mgr.ListProject("any-project"); len(got) != 0 {
		t.Fatalf("a project lists the login: %+v", got)
	}
	if err := f.svc.Close("cc", l.ID); err != nil {
		t.Fatal(err)
	}
	wantDone(t, l)
}

func TestOneLoginPerAgent(t *testing.T) {
	f := newFixture(t, `sleep 30`, agentlogin.Options{PollEvery: time.Hour})
	first, err := f.svc.Start(context.Background(), "cc@work", agentlogin.Request{Method: "script"})
	if err != nil {
		t.Fatal(err)
	}
	other, err := f.svc.Start(context.Background(), "cc", agentlogin.Request{Method: "script"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.svc.Start(context.Background(), "cc@work", agentlogin.Request{Method: "script"})
	if err != nil {
		t.Fatal(err)
	}
	if !first.Session().Finished() {
		t.Fatal("the first login still runs")
	}
	wantDone(t, first)
	if _, err := f.svc.Get("cc@work", first.ID); !errors.Is(err, agentlogin.ErrNotFound) {
		t.Fatalf("Get(old) = %v", err)
	}
	if got, err := f.svc.Get("cc@work", second.ID); err != nil || got != second {
		t.Fatalf("Get(new) = %v, %v", got, err)
	}
	if _, err := f.svc.Get("cc", other.ID); err != nil || other.Session().Finished() {
		t.Fatalf("the login of another account was touched: %v", err)
	}
	if _, err := f.svc.Get("cc", second.ID); !errors.Is(err, agentlogin.ErrNotFound) {
		t.Fatalf("a session id of another agent: %v", err)
	}
}

func TestStartErrors(t *testing.T) {
	f := newFixture(t, `true`, agentlogin.Options{})
	var un *agentlogin.UnavailableError
	for _, tc := range []struct {
		name, agent, method string
		notFound            bool
	}{
		{"unknown agent", "nope", "", true},
		{"no login command", "plain", "", false},
		{"unknown method", "cc", "device", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := f.svc.Start(context.Background(), tc.agent, agentlogin.Request{Method: tc.method})
			if tc.notFound != errors.Is(err, agentlogin.ErrNotFound) || (!tc.notFound && !errors.As(err, &un)) {
				t.Fatalf("err = %v", err)
			}
		})
	}
	if err := f.svc.Close("cc", "tm_x"); !errors.Is(err, agentlogin.ErrNotFound) {
		t.Fatalf("Close(unknown) = %v", err)
	}
}

func TestPollingStopsAtOKAndAHardStopEndsALogin(t *testing.T) {
	f := newFixture(t, `sleep 1; touch "$CLAUDE_CONFIG_DIR/ok"; sleep 60`, agentlogin.Options{PollEvery: 50 * time.Millisecond, MaxLife: 3 * time.Second})
	l, err := f.svc.Start(context.Background(), "cc@work", agentlogin.Request{Method: "script"})
	if err != nil {
		t.Fatal(err)
	}
	ch, release := l.Watch()
	defer release()
	wantState(t, ch, agentlogin.StateNotLoggedIn)
	wantState(t, ch, agentlogin.StateOK) // while the command still runs
	if l.Session().Finished() {
		t.Fatal("the command ended before its hard stop")
	}
	wantDone(t, l) // the 3 s cap kills `sleep 60`
	if !l.Session().Finished() {
		t.Fatal("the hard stop did not end the command")
	}
	if got := states(ch); len(got) > 0 && got[len(got)-1] != agentlogin.StateOK {
		t.Fatalf("states after ok = %v", got)
	}
}
