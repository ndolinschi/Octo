package bridge_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/accounts"
	"github.com/ndolinschi/Octo/apps/harness/internal/agentlogin"
	"github.com/ndolinschi/Octo/apps/harness/internal/bridge"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/providers"
	"github.com/ndolinschi/Octo/apps/harness/internal/terminal"
)

// "cc" keeps accounts and is logged in when $CLAUDE_CONFIG_DIR/ok exists; its
// "script" login asks for a code, then logs in. "cop" can keep one login only,
// "plain" has no accounts block and no login command.
const accountsManifest = `{"name":"p","version":"1","agents":[
 {"id":"cc","label":"Claude Code","command":"sh","accounts":{"env":"CLAUDE_CONFIG_DIR","default":"~/.cc-default"},
  "auth":{"command":"cc auth login","probe":["sh","-c","test -f \"$CLAUDE_CONFIG_DIR/ok\""],"notLoggedInExit":[1],
   "login":[{"id":"script","label":"Script","args":["sh","-c","printf 'code? '; read x; touch \"$CLAUDE_CONFIG_DIR/ok\"; echo thanks-$x"]}]}},
 {"id":"cop","label":"Copilot","command":"sh","accounts":{"unsupported":"the keychain is shared"}},
 {"id":"plain","label":"Plain","command":"sh"},
 {"id":"gone","label":"Gone CLI","command":"octo-test-no-such-cli","install":"Run npm install -g gone-cli first.",
  "accounts":{"env":"GONE_HOME"},"auth":{"login":[{"id":"l","label":"Log in","args":["octo-test-no-such-cli","login"]}]}}]}`

type accountsEnv struct {
	*env
	data string
}

func newAccountsEnv(t *testing.T, opts ...bridge.Option) *accountsEnv {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("uses sh")
	}
	data := t.TempDir()
	dir := filepath.Join(data, "plugins", "p")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, plugins.ManifestName), []byte(accountsManifest), 0o644); err != nil {
		t.Fatal(err)
	}
	reg := plugins.Load(context.Background(), data, nil, nil)
	store := accounts.Open(data)
	reg.SetAccounts(store.List)
	reg.SetDefaultLabels(store.DefaultLabels)
	prov := providers.New(providers.Options{DataDir: data, Agents: reg.Agents, Recheck: reg.Recheck, Fresh: reg.Fresh})
	t.Cleanup(prov.WaitIdle)
	svc := &accounts.Service{Store: store, Agent: reg.Agent, Recheck: prov.Recheck, Refresh: prov.Refresh, Provider: prov.Provider, Forget: reg.Forget}
	mgr := terminal.NewManager(terminal.Options{})
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = mgr.Shutdown(ctx)
	})
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	logins := agentlogin.New(ctx, reg, mgr, agentlogin.Options{PollEvery: 50 * time.Millisecond, Home: func() string { return data }})
	all := append([]bridge.Option{bridge.WithProviders(prov), bridge.WithAccounts(svc), bridge.WithAgentLogins(logins)}, opts...)
	return &accountsEnv{env: newEnvWith(t, nil, reg, all...), data: data}
}

// accountReply is the providers entry an add or a rename answers.
type accountReply struct {
	ID                  string `json:"id"`
	Label               string `json:"label"`
	AccountOf           string `json:"account_of"`
	AccountID           string `json:"account_id"`
	AccountLabel        string `json:"account_label"`
	AccountDir          string `json:"account_dir"`
	AccountOwned        bool   `json:"account_owned"`
	AccountDefaultLabel string `json:"account_default_label"`
	AccountUnsupported  string `json:"account_unsupported"`
}

// addAccount adds an account of agent whose folder Octo creates under the data folder.
func (e *accountsEnv) addAccount(t *testing.T, agent, label string) accountReply {
	t.Helper()
	var got accountReply
	dir := filepath.Join(e.data, "accounts", agent, strings.ToLower(label))
	e.into(t, "POST", "/v1/providers/"+agent+"/accounts", map[string]any{"label": label, "config_dir": dir}, http.StatusCreated, &got)
	return got
}

func TestAccountRenameAndRemoveWithFolder(t *testing.T) {
	e := newAccountsEnv(t)
	work := e.addAccount(t, "cc", "Work")
	if !work.AccountOwned || work.AccountID != "work" {
		t.Fatalf("added = %+v", work)
	}
	existing := t.TempDir()
	var mine accountReply
	e.into(t, "POST", "/v1/providers/cc/accounts", map[string]any{"label": "Mine", "config_dir": existing}, http.StatusCreated, &mine)
	if mine.AccountOwned {
		t.Fatalf("a folder Octo did not create is owned: %+v", mine)
	}

	for _, tc := range []struct {
		name, method, path string
		body               any
		status             int
		code               string
	}{
		{"rename: unknown account", "PATCH", "/v1/providers/cc@nope/account", map[string]any{"label": "X"}, 404, "not_found"},
		{"rename: label taken", "PATCH", "/v1/providers/cc@work/account", map[string]any{"label": "mine"}, 409, "conflict"},
		{"rename: empty", "PATCH", "/v1/providers/cc@work/account", map[string]any{"label": ""}, 400, "invalid_request"},
		{"rename: one login only", "PATCH", "/v1/providers/cop/account", map[string]any{"label": "X"}, 400, "invalid_request"},
		{"rename: unknown agent", "PATCH", "/v1/providers/nope/account", map[string]any{"label": "X"}, 404, "not_found"},
		{"remove: a folder Octo did not create", "DELETE", "/v1/providers/cc/accounts/mine?delete_folder=true", nil, 409, "conflict"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e.wantError(t, tc.method, tc.path, tc.body, tc.status, tc.code)
		})
	}
	var renamed accountReply
	e.into(t, "PATCH", "/v1/providers/cc@work/account", map[string]any{"label": "Job"}, http.StatusOK, &renamed)
	if renamed.ID != "cc@work" || renamed.AccountLabel != "Job" || renamed.Label != "Claude Code · Job" {
		t.Fatalf("renamed = %+v", renamed)
	}
	var def accountReply
	e.into(t, "PATCH", "/v1/providers/cc/account", map[string]any{"label": "Personal"}, http.StatusOK, &def)
	if def.ID != "cc" || def.AccountDefaultLabel != "Personal" || def.Label != "Claude Code · Personal" {
		t.Fatalf("default renamed = %+v", def)
	}
	if _, err := os.Stat(existing); err != nil {
		t.Fatalf("a refused removal touched the folder: %v", err)
	}
	e.into(t, "DELETE", "/v1/providers/cc/accounts/mine", nil, http.StatusNoContent, nil)
	e.into(t, "DELETE", "/v1/providers/cc/accounts/work?delete_folder=true", nil, http.StatusNoContent, nil)
	if _, err := os.Stat(work.AccountDir); !os.IsNotExist(err) {
		t.Fatalf("the folder Octo created is still there: %v", err)
	}
	if _, err := os.Stat(existing); err != nil {
		t.Fatalf("the chosen folder is gone: %v", err)
	}
	var list struct {
		Providers []accountReply `json:"providers"`
	}
	e.into(t, "GET", "/v1/providers", nil, http.StatusOK, &list)
	for _, p := range list.Providers {
		if strings.Contains(p.ID, "@") {
			t.Fatalf("an account is still listed: %s", p.ID)
		}
		if p.ID == "cop" && p.AccountUnsupported != "the keychain is shared" || p.ID == "plain" && p.AccountUnsupported != plugins.NoAccountsReason {
			t.Fatalf("%s: account_unsupported = %q", p.ID, p.AccountUnsupported)
		}
	}
}

func TestAccountRoutesNeedTheServices(t *testing.T) {
	e := newEnvWith(t, nil, nil)
	for _, r := range [][2]string{{"POST", "/v1/providers/cc/accounts"}, {"PATCH", "/v1/providers/cc/account"}, {"POST", "/v1/providers/cc/login"}} {
		if st, _ := e.do(t, r[0], r[1], map[string]any{"label": "x"}); st != http.StatusNotFound && st != http.StatusMethodNotAllowed {
			t.Errorf("%s %s = %d without the services", r[0], r[1], st)
		}
	}
}

func decodeOutput(t *testing.T, ev rawEvent) string {
	t.Helper()
	var d struct{ Data string }
	if err := json.Unmarshal([]byte(ev.Data), &d); err != nil {
		t.Fatalf("output frame %q: %v", ev.Data, err)
	}
	raw, err := base64.StdEncoding.DecodeString(d.Data)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// A login for an agent whose CLI is not installed is the "not installed"
// problem with its install line; no terminal is started.
func TestLoginOfAnAgentThatIsNotInstalled(t *testing.T) {
	e := newAccountsEnv(t)
	code, body := e.do(t, "POST", "/v1/providers/gone/login", nil)
	if code != http.StatusConflict {
		t.Fatalf("status = %d: %s", code, body)
	}
	var out struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
			Command string `json:"command"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatal(err)
	}
	if out.Error.Code != "agent_not_installed" || out.Error.Message != "Gone CLI is not installed." || out.Error.Command != "npm install -g gone-cli" {
		t.Fatalf("error = %+v", out.Error)
	}
}
