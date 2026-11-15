package acp_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakeacp"
)

// agyPolicy is the auth policy the built-in antigravity entry yields.
var agyPolicy = acp.AuthPolicy{
	Methods: []acp.AuthPref{{ID: fakeacp.AgyAuthAPIKey, RequiresEnv: "GEMINI_API_KEY"}},
	Skip:    []string{fakeacp.AgyAuthGoogle, fakeacp.AgyAuthEnterprise, fakeacp.AgyAuthPlatform, fakeacp.AgyAuthTerminal},
}

func agySpec(t *testing.T, dir string, env map[string]string) acp.Spec {
	t.Helper()
	e := map[string]string{fakeacp.EnvProfile: fakeacp.ProfileAgy}
	for k, v := range env {
		e[k] = v
	}
	spec := fakeSpec(dir, e)
	spec.Args = []string{"acp"}
	spec.Name = "antigravity"
	return spec
}

func authLog(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(b))
}

// The agy profile prints a banner on stdout before its first message; the
// handshake still works and reads what agy advertises.
func TestAgyHandshakeSurvivesTheBanner(t *testing.T) {
	dir := t.TempDir()
	c, err := acp.Start(context.Background(), agySpec(t, dir, nil))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	caps := c.Capabilities()
	if !caps.LoadSession || !caps.PromptImage || !caps.MCPHTTP {
		t.Fatalf("caps = %+v", caps)
	}
}

// Without a saved sign-in agy refuses session/new with "Authentication
// required"; the built-in policy tries no browser or terminal sign-in and the
// API-key method only with GEMINI_API_KEY set, so the client answers at once
// with ErrAuthRequired naming why.
func TestAgyNotSignedInNeverStartsABrowserSignIn(t *testing.T) {
	dir := t.TempDir()
	log := filepath.Join(t.TempDir(), "auth.log")
	c, err := acp.Start(context.Background(), agySpec(t, dir, map[string]string{
		fakeacp.EnvAuthLog: log, fakeacp.EnvLoginFile: filepath.Join(t.TempDir(), "absent"),
	}))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_, err = c.NewSession(context.Background(), dir, nil, acp.RunOptions{AuthHint: "Run `agy acp --login`.", Auth: agyPolicy})
	if !errors.Is(err, acp.ErrAuthRequired) {
		t.Fatalf("err = %v, want ErrAuthRequired", err)
	}
	for _, want := range []string{"Authentication required", "gemini-api-key (needs GEMINI_API_KEY set)", "agy acp --login"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q lacks %q", err, want)
		}
	}
	if got := authLog(t, log); got != "" {
		t.Fatalf("authenticate was called: %q", got)
	}
}

// The default policy (no manifest preferences) would try oauth-personal, a
// browser sign-in agy describes only by name: this is why the manifest lists
// its methods.
func TestAgyDefaultPolicyWouldTryTheBrowserSignIn(t *testing.T) {
	dir := t.TempDir()
	log := filepath.Join(t.TempDir(), "auth.log")
	c, err := acp.Start(context.Background(), agySpec(t, dir, map[string]string{fakeacp.EnvAuthLog: log}))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_, err = c.NewSession(context.Background(), dir, nil, acp.RunOptions{})
	if !errors.Is(err, acp.ErrAuthRequired) || !strings.Contains(authLog(t, log), fakeacp.AgyAuthGoogle) {
		t.Fatalf("err = %v, auth log %q", err, authLog(t, log))
	}
}

// With GEMINI_API_KEY forwarded on purpose, the API-key method is used; with a
// saved sign-in nothing needs authenticating. Either way the session offers
// agy's models (config option, with labels), its four modes starting in auto,
// and the model is switched through the config option.
func TestAgySignedInSessionModelsAndModes(t *testing.T) {
	login := filepath.Join(t.TempDir(), "login")
	if err := os.WriteFile(login, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	for name, env := range map[string]map[string]string{
		"api key":     {"GEMINI_API_KEY": "test-key"},
		"saved login": {fakeacp.EnvLoginFile: login},
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			log := filepath.Join(t.TempDir(), "auth.log")
			env[fakeacp.EnvAuthLog] = log
			c, err := acp.Start(context.Background(), agySpec(t, dir, env))
			if err != nil {
				t.Fatal(err)
			}
			defer c.Close()
			var models []acp.AdvertisedModel
			var current string
			sess, err := c.NewSession(context.Background(), dir, nil, acp.RunOptions{
				Auth: agyPolicy, Model: "gemini-pro", ModelRequired: true,
				OnModels: func(m []acp.AdvertisedModel, cur string) { models, current = m, cur },
			})
			if err != nil {
				t.Fatal(err)
			}
			if len(models) != 2 || models[1].ID != "gemini-pro" || models[1].Label != "Gemini Pro" || current != "gemini-flash" {
				t.Fatalf("models = %+v current %q", models, current)
			}
			if sess.Mode != "auto" || len(sess.Modes) != 4 {
				t.Fatalf("modes = %+v current %q", sess.Modes, sess.Mode)
			}
			want := ""
			if name == "api key" {
				want = fakeacp.AgyAuthAPIKey
			}
			if got := authLog(t, log); got != want {
				t.Fatalf("auth log = %q, want %q", got, want)
			}
			h := newRec()
			if _, err := c.Prompt(context.Background(), sess.ID, "go", h); err != nil {
				t.Fatal(err)
			}
			if err := c.SetMode(context.Background(), sess.ID, "default"); err != nil {
				t.Fatal(err)
			}
			h = newRec()
			if _, err := c.Prompt(context.Background(), sess.ID, fakeacp.MarkerMode, h); err != nil || !strings.Contains(h.text.String(), "mode=default") {
				t.Fatalf("mode after set_mode: %q, %v", h.text.String(), err)
			}
		})
	}
}

// An agy older than 1.5.0 has no `acp` subcommand: the start fails with the
// CLI's own usage error as the first stderr line (what launchRejection reads).
func TestAgyBeforeACPRejectsTheSubcommand(t *testing.T) {
	_, err := acp.Start(context.Background(), agySpec(t, t.TempDir(), map[string]string{fakeacp.EnvAgyVersion: "1.4.12"}))
	var exit *acp.ExitError
	if !errors.As(err, &exit) || !strings.Contains(exit.StderrFirst, `unknown command "acp" for "agy"`) {
		t.Fatalf("err = %v", err)
	}
}

// blockingPerm waits for the user (here: forever) on every permission request,
// as a supervised project's approval card does.
type blockingPerm struct {
	*recHandler
	asked chan struct{}
	ended chan error
}

func (h *blockingPerm) RequestPermission(ctx context.Context, _ acp.PermissionRequest) string {
	close(h.asked)
	<-ctx.Done()
	h.ended <- ctx.Err()
	return "allow"
}

// Stop while a permission request waits for the user: the question is
// withdrawn (its context ends), the agent's "cancelled" answer is read, the
// prompt ends cancelled well inside CancelGrace and the process stays alive
// for the next prompt (agy 1.5.2: "permission requests ... now close when ...
// their prompt ends").
func TestCancelDuringAPermissionRequestEndsCleanly(t *testing.T) {
	dir := t.TempDir()
	login := filepath.Join(t.TempDir(), "login")
	if err := os.WriteFile(login, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := acp.Start(context.Background(), agySpec(t, dir, map[string]string{fakeacp.EnvLoginFile: login}))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	pid := c.PID()
	sess, err := c.NewSession(context.Background(), dir, nil, acp.RunOptions{Auth: agyPolicy})
	if err != nil {
		t.Fatal(err)
	}
	h := &blockingPerm{recHandler: newRec(), asked: make(chan struct{}), ended: make(chan error, 1)}
	ctx, cancel := context.WithCancel(context.Background())
	go func() { <-h.asked; cancel() }()
	start := time.Now()
	stop, err := c.Prompt(ctx, sess.ID, fakeacp.MarkerPerm, h)
	if err != nil || stop != acp.StopCancelled {
		t.Fatalf("Prompt = %q, %v", stop, err)
	}
	if d := time.Since(start); d >= acp.CancelGrace {
		t.Fatalf("cancel took %s: the agent was killed instead of answering", d)
	}
	select {
	case e := <-h.ended:
		if !errors.Is(e, context.Canceled) {
			t.Fatalf("permission context ended with %v", e)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the permission request was never withdrawn")
	}
	if _, err := os.Stat(filepath.Join(dir, fakeacp.PermFile)); err == nil {
		t.Fatal("the command ran although the request was cancelled")
	}
	if !alive(pid) {
		t.Fatal("agent process was killed")
	}
	h2 := newRec()
	if stop, err := c.Prompt(context.Background(), sess.ID, "go", h2); err != nil || stop != acp.StopEndTurn {
		t.Fatalf("next prompt = %q, %v", stop, err)
	}
}
