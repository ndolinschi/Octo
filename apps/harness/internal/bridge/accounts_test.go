package bridge_test

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/accounts"
)

type accountEntry struct {
	ID, State, Login, Label string
	LoginHint               string `json:"login_hint"`
	AccountEnv              string `json:"account_env"`
	AccountDefault          string `json:"account_default"`
	AccountOf               string `json:"account_of"`
	AccountID               string `json:"account_id"`
	AccountLabel            string `json:"account_label"`
	AccountDir              string `json:"account_dir"`
}

// An agent with `accounts`: each account is the same agent started with its
// own folder in OCTO_T_HOME, and its login probe looks only in that folder.
func TestAgentAccountsOverHTTP(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses sh")
	}
	keeper := agentManifest("keeper", map[string]any{
		"accounts": map[string]any{"env": "OCTO_T_HOME", "default": "~/.keeper"},
		"auth": map[string]any{"probe": []string{"sh", "-c", `test -f "$OCTO_T_HOME/logged-in"`}, "notLoggedInExit": []int{1},
			"command": "keeper login", "hint": "Run `keeper login` once."},
	})
	e := newProvEnv(t, "", agentManifest("scripted", nil), keeper)
	waitUntil(t, "the probe", func() bool { return e.providers(t).entry(t, "keeper").State == "not_logged_in" })

	var base accountEntry
	for _, p := range rawProviders(t, e) {
		if p.ID == "keeper" {
			base = p
		}
	}
	if base.AccountEnv != "OCTO_T_HOME" || base.AccountDefault != "~/.keeper" || base.AccountOf != "" {
		t.Fatalf("base entry = %+v", base)
	}

	work := filepath.Join(t.TempDir(), "keeper work")
	var got accountEntry
	e.into(t, "POST", "/v1/providers/keeper/accounts", map[string]string{"label": "Work", "config_dir": work}, http.StatusCreated, &got)
	if got.ID != "keeper@work" || got.AccountOf != "keeper" || got.AccountID != "work" || got.AccountLabel != "Work" ||
		got.AccountDir != work || got.Label != "Keeper · Work" || got.State != "not_logged_in" {
		t.Fatalf("added = %+v", got)
	}
	if want := "OCTO_T_HOME='" + work + "' keeper login"; !strings.Contains(got.LoginHint, want) {
		t.Fatalf("login hint %q does not contain %q", got.LoginHint, want)
	}
	if fi, err := os.Stat(work); err != nil || !fi.IsDir() || fi.Mode().Perm() != 0o700 {
		t.Fatalf("account folder: %v %v", fi, err)
	}

	// Logging the account's folder in makes that account ready; the agent's own entry is unchanged.
	if err := os.WriteFile(filepath.Join(work, "logged-in"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	e.into(t, "POST", "/v1/providers/keeper@work/recheck", nil, http.StatusOK, &got)
	if got.State != "ready" || got.Login != "ok" {
		t.Fatalf("account after login = %+v", got)
	}
	e.into(t, "POST", "/v1/providers/keeper/recheck", nil, http.StatusOK, &got)
	if got.State != "not_logged_in" {
		t.Fatalf("base after the account's login = %+v", got)
	}

	// Listed right after its agent.
	var ids []string
	for _, p := range rawProviders(t, e) {
		ids = append(ids, p.ID)
	}
	at := strings.Index(strings.Join(ids, ","), "keeper,keeper@work")
	if at < 0 {
		t.Fatalf("order = %v", ids)
	}

	// The account can be chosen like any agent.
	e.createProject(t, map[string]string{"orchestrator": "acp:keeper@work"}, http.StatusCreated, nil)

	// Refusals in the catalogue's words.
	e.wantError(t, "POST", "/v1/providers/keeper/accounts", map[string]string{"label": "Work", "config_dir": work + "-2"}, http.StatusConflict, "conflict")
	e.wantError(t, "POST", "/v1/providers/keeper/accounts", map[string]string{"label": "Other", "config_dir": work}, http.StatusConflict, "conflict")
	e.wantError(t, "POST", "/v1/providers/keeper/accounts", map[string]string{"label": "Rel", "config_dir": "relative/dir"}, http.StatusBadRequest, "invalid_request")
	e.wantError(t, "POST", "/v1/providers/keeper/accounts", map[string]string{"label": "Env", "config_dir": "/tmp/${HOME}"}, http.StatusBadRequest, "invalid_request")
	e.wantError(t, "POST", "/v1/providers/keeper/accounts", map[string]string{"label": "Default", "config_dir": "~/.keeper"}, http.StatusBadRequest, "invalid_request")
	e.wantError(t, "POST", "/v1/providers/keeper/accounts", map[string]string{"label": "", "config_dir": work + "-3"}, http.StatusBadRequest, "invalid_request")
	e.wantError(t, "POST", "/v1/providers/scripted/accounts", map[string]string{"label": "X", "config_dir": work + "-4"}, http.StatusBadRequest, "invalid_request")
	e.wantError(t, "POST", "/v1/providers/keeper@work/accounts", map[string]string{"label": "X", "config_dir": work + "-5"}, http.StatusBadRequest, "invalid_request")
	e.wantError(t, "POST", "/v1/providers/nope/accounts", map[string]string{"label": "X", "config_dir": work + "-6"}, http.StatusNotFound, "not_found")

	// The file keeps the label and the folder only, readable by the owner alone.
	file := filepath.Join(e.env.dir, accounts.File)
	fi, err := os.Stat(file)
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("accounts file: %v %v", fi, err)
	}
	var body struct {
		Accounts []map[string]any `json:"accounts"`
	}
	raw, _ := os.ReadFile(file)
	if err := json.Unmarshal(raw, &body); err != nil || len(body.Accounts) != 1 || len(body.Accounts[0]) != 4 {
		t.Fatalf("accounts file = %s", raw)
	}

	// Removing forgets it (the folder stays).
	e.into(t, "DELETE", "/v1/providers/keeper/accounts/work", nil, http.StatusNoContent, nil)
	e.wantError(t, "DELETE", "/v1/providers/keeper/accounts/work", nil, http.StatusNotFound, "not_found")
	for _, p := range rawProviders(t, e) {
		if p.ID == "keeper@work" {
			t.Fatalf("still listed after removal")
		}
	}
	if _, err := os.Stat(filepath.Join(work, "logged-in")); err != nil {
		t.Fatalf("the folder's contents were touched: %v", err)
	}
}

func rawProviders(t *testing.T, e *provEnv) []accountEntry {
	t.Helper()
	var r struct{ Providers []accountEntry }
	e.into(t, "GET", "/v1/providers", nil, http.StatusOK, &r)
	return r.Providers
}
