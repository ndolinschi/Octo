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
 {"id":"cc","label":"Claude Code","command":"sh","accounts":{"env":{"CLAUDE_CONFIG_DIR":"{dir}"}},
  "auth":{"command":"cc auth login","probe":["sh","-c","test -f \"$CLAUDE_CONFIG_DIR/ok\""],"notLoggedInExit":[1],
   "login":[{"id":"script","label":"Script","args":["sh","-c","printf 'code? '; read x; touch \"$CLAUDE_CONFIG_DIR/ok\"; echo thanks-$x"]}]}},
 {"id":"cop","label":"Copilot","command":"sh","accounts":{"unsupported":"the keychain is shared"}},
 {"id":"plain","label":"Plain","command":"sh"},
 {"id":"gone","label":"Gone CLI","command":"octo-test-no-such-cli","install":"Run npm install -g gone-cli first.",
  "accounts":{"env":{"GONE_HOME":"{dir}"}},"auth":{"login":[{"id":"l","label":"Log in","args":["octo-test-no-such-cli","login"]}]}}]}`

type accountsEnv struct {
	*env
	data string
	svc  *accounts.Service
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
	prov := providers.New(providers.Options{DataDir: data, Agents: reg.Agents, Recheck: reg.Recheck, Fresh: reg.Fresh})
	t.Cleanup(prov.WaitIdle)
	svc, err := accounts.Open(data, reg, prov.Refresh)
	if err != nil {
		t.Fatal(err)
	}
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
	return &accountsEnv{env: newEnvWith(t, nil, reg, all...), data: data, svc: svc}
}

type accountReply struct {
	Account  plugins.AccountInfo `json:"account"`
	Provider struct {
		ID      string `json:"id"`
		Label   string `json:"label"`
		BaseID  string `json:"base_id"`
		Account *struct {
			Name string `json:"name"`
		} `json:"account"`
	} `json:"provider"`
}

func TestAccountRoutes(t *testing.T) {
	e := newAccountsEnv(t)
	existing := t.TempDir()

	var added accountReply
	e.into(t, "POST", "/v1/providers/cc/accounts", map[string]any{"name": "Work"}, http.StatusCreated, &added)
	wantDir := filepath.Join(e.data, "accounts", "cc", "work")
	if a := added.Account; a.ID != "work" || a.Name != "Work" || a.Default || !a.Owned || a.Dir != wantDir {
		t.Fatalf("account = %+v", a)
	}
	if p := added.Provider; p.ID != "cc@work" || p.BaseID != "cc" || p.Account == nil || p.Account.Name != "Work" {
		t.Fatalf("provider = %+v", p)
	}
	if st, err := os.Stat(wantDir); err != nil || st.Mode().Perm() != 0o700 {
		t.Fatalf("account folder = %v, %v", st, err)
	}

	var own accountReply
	e.into(t, "POST", "/v1/providers/cc/accounts", map[string]any{"name": "Mine", "dir": existing}, http.StatusCreated, &own)
	if own.Account.Owned || own.Account.Dir != existing || own.Provider.ID != "cc@mine" {
		t.Fatalf("own folder account = %+v / %s", own.Account, own.Provider.ID)
	}

	for _, tc := range []struct {
		name, method, path string
		body               any
		status             int
		code               string
	}{
		{"add: name taken", "POST", "/v1/providers/cc/accounts", map[string]any{"name": "work"}, 409, "account_name_taken"},
		{"add: the default's name is taken", "POST", "/v1/providers/cc/accounts", map[string]any{"name": "Default"}, 409, "account_name_taken"},
		{"add: one login only", "POST", "/v1/providers/cop/accounts", map[string]any{"name": "Two"}, 409, "accounts_unsupported"},
		{"add: no accounts block", "POST", "/v1/providers/plain/accounts", map[string]any{"name": "Two"}, 409, "accounts_unsupported"},
		{"add: unknown agent", "POST", "/v1/providers/nope/accounts", map[string]any{"name": "Two"}, 404, "not_found"},
		{"add: empty name", "POST", "/v1/providers/cc/accounts", map[string]any{"name": " "}, 400, "invalid_request"},
		{"add: name too long", "POST", "/v1/providers/cc/accounts", map[string]any{"name": strings.Repeat("n", 41)}, 400, "invalid_request"},
		{"add: relative folder", "POST", "/v1/providers/cc/accounts", map[string]any{"name": "R", "dir": "rel/dir"}, 400, "invalid_request"},
		{"add: folder with a variable", "POST", "/v1/providers/cc/accounts", map[string]any{"name": "V", "dir": "/x/${HOME}"}, 400, "invalid_request"},
		{"add: not a folder", "POST", "/v1/providers/cc/accounts", map[string]any{"name": "F", "dir": filepath.Join(e.data, "plugins", "p", plugins.ManifestName)}, 400, "invalid_request"},
		{"rename: unknown account", "PATCH", "/v1/providers/cc@nope/account", map[string]any{"name": "X"}, 404, "not_found"},
		{"rename: name taken", "PATCH", "/v1/providers/cc@work/account", map[string]any{"name": "mine"}, 409, "account_name_taken"},
		{"rename: empty", "PATCH", "/v1/providers/cc@work/account", map[string]any{"name": ""}, 400, "invalid_request"},
		{"rename: one login only", "PATCH", "/v1/providers/cop/account", map[string]any{"name": "X"}, 409, "accounts_unsupported"},
		{"remove: the default", "DELETE", "/v1/providers/cc/account", nil, 409, "account_default"},
		{"remove: unknown account", "DELETE", "/v1/providers/cc@nope/account", nil, 404, "not_found"},
		{"remove: unknown agent", "DELETE", "/v1/providers/nope/account", nil, 404, "not_found"},
		{"remove: bad flag", "DELETE", "/v1/providers/cc@work/account?delete_data=maybe", nil, 400, "invalid_request"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e.wantError(t, tc.method, tc.path, tc.body, tc.status, tc.code)
		})
	}

	if r, err := http.Post(e.url+"/v1/providers/cc/accounts", "application/json", strings.NewReader("{")); err != nil || r.StatusCode != http.StatusBadRequest {
		t.Fatalf("a body that is not JSON: %v, %v", r, err)
	}
	var renamed accountReply
	e.into(t, "PATCH", "/v1/providers/cc@work/account", map[string]any{"name": "Job"}, http.StatusOK, &renamed)
	if renamed.Account.ID != "work" || renamed.Account.Name != "Job" || renamed.Provider.Label != "Claude Code · Job" {
		t.Fatalf("renamed = %+v", renamed)
	}
	var def accountReply
	e.into(t, "PATCH", "/v1/providers/cc/account", map[string]any{"name": "Personal"}, http.StatusOK, &def)
	if !def.Account.Default || def.Account.ID != "" || def.Account.Name != "Personal" || def.Provider.ID != "cc" {
		t.Fatalf("default renamed = %+v", def)
	}

	var gone struct {
		Removed    string  `json:"removed"`
		DeletedDir *string `json:"deleted_dir"`
	}
	e.into(t, "DELETE", "/v1/providers/cc@mine/account?delete_data=true", nil, http.StatusOK, &gone)
	if gone.Removed != "cc@mine" || gone.DeletedDir != nil {
		t.Fatalf("a folder Octo did not create is deleted: %+v", gone)
	}
	if _, err := os.Stat(existing); err != nil {
		t.Fatalf("the chosen folder is gone: %v", err)
	}
	e.into(t, "DELETE", "/v1/providers/cc@work/account", nil, http.StatusOK, &gone)
	if gone.DeletedDir != nil {
		t.Fatalf("deleted_dir without being asked: %v", *gone.DeletedDir)
	}
	e.wantError(t, "DELETE", "/v1/providers/cc@work/account", nil, http.StatusNotFound, "not_found")
	if _, err := os.Stat(wantDir); err != nil {
		t.Fatalf("the folder was removed without delete_data: %v", err)
	}
	var again accountReply
	e.into(t, "POST", "/v1/providers/cc/accounts", map[string]any{"name": "Work"}, http.StatusCreated, &again)
	// The first folder is still there, so the new account gets its own slug and folder.
	wantDir = again.Account.Dir
	e.into(t, "DELETE", "/v1/providers/"+again.Provider.ID+"/account?delete_data=true", nil, http.StatusOK, &gone)
	if gone.DeletedDir == nil || *gone.DeletedDir != wantDir {
		t.Fatalf("deleted_dir = %v", gone.DeletedDir)
	}
	if _, err := os.Stat(wantDir); !os.IsNotExist(err) {
		t.Fatalf("the folder is still there: %v", err)
	}
	var list struct {
		Providers []struct{ ID string } `json:"providers"`
	}
	e.into(t, "GET", "/v1/providers", nil, http.StatusOK, &list)
	for _, p := range list.Providers {
		if strings.Contains(p.ID, "@") {
			t.Fatalf("an account is still listed: %s", p.ID)
		}
	}
}

func TestAccountRoutesNeedTheServices(t *testing.T) {
	e := newEnvWith(t, nil, nil)
	for _, r := range [][2]string{{"POST", "/v1/providers/cc/accounts"}, {"PATCH", "/v1/providers/cc/account"}, {"POST", "/v1/providers/cc/login"}} {
		if st, _ := e.do(t, r[0], r[1], map[string]any{"name": "x"}); st != http.StatusNotFound && st != http.StatusMethodNotAllowed {
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

// failingEditor refuses every change as the accounts service does for a file
// it cannot read.
type failingEditor struct{}

func (failingEditor) Add(string, string, string) (accounts.Account, error) {
	return accounts.Account{}, accounts.ErrFileUnusable
}
func (failingEditor) Rename(string, string) (accounts.Account, error) {
	return accounts.Account{}, accounts.ErrFileUnusable
}
func (failingEditor) Remove(string, bool) (string, error) { return "", accounts.ErrFileUnusable }

func TestUnusableAccountsFileIsReportedAsItself(t *testing.T) {
	e := newAccountsEnv(t, bridge.WithAccounts(failingEditor{}))
	for _, tc := range []struct {
		method, path string
		body         any
	}{
		{"POST", "/v1/providers/cc/accounts", map[string]any{"name": "Work"}},
		{"PATCH", "/v1/providers/cc@work/account", map[string]any{"name": "Main"}},
		{"DELETE", "/v1/providers/cc@work/account", nil},
	} {
		code, body := e.do(t, tc.method, tc.path, tc.body)
		var out struct {
			Error struct{ Code, Message, Hint string } `json:"error"`
		}
		if err := json.Unmarshal(body, &out); err != nil {
			t.Fatal(err)
		}
		if code != http.StatusConflict || out.Error.Code != "accounts_file_unusable" ||
			!strings.Contains(out.Error.Message, accounts.FileName) || !strings.Contains(out.Error.Hint, "restart") {
			t.Errorf("%s %s = %d %s", tc.method, tc.path, code, body)
		}
	}
}
