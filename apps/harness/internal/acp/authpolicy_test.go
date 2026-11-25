package acp_test

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakeacp"
)

const droidLike = `[
 {"id":"device-pairing","name":"Device pairing","description":"Pair this device in the browser"},
 {"id":"factory-api-key","name":"API key","description":"Use FACTORY_API_KEY"},
 {"id":"cached_token","name":"Cached token","description":"Use the cached token"},
 {"id":"cursor_login","name":"Cursor login"},
 {"id":"env-thing","name":"Env","type":"env_var"},
 {"id":"term","name":"Term","type":"terminal"}
]`

func TestAuthPolicy(t *testing.T) {
	tests := []struct {
		name      string
		ok        string
		policy    acp.AuthPolicy
		childEnv  map[string]string
		wantTried string // comma-joined ids in order
		wantErr   []string
	}{
		{"default skips interactive-looking ids, tries the rest in order", "cached_token", acp.AuthPolicy{}, nil,
			"factory-api-key,cached_token", nil},
		{"default: nothing usable", "none", acp.AuthPolicy{}, nil, "factory-api-key,cached_token", []string{"authenticate failed"}},
		{"methods are the only ones tried, in order", "cached_token",
			acp.AuthPolicy{Methods: []acp.AuthPref{{ID: "cached_token"}, {ID: "factory-api-key"}}}, nil, "cached_token", nil},
		{"requiresEnv unset: method is not tried", "cached_token",
			acp.AuthPolicy{Methods: []acp.AuthPref{{ID: "factory-api-key", RequiresEnv: "FACTORY_API_KEY"}, {ID: "cached_token"}}}, nil,
			"cached_token", nil},
		{"requiresEnv set in the child env: tried first", "factory-api-key",
			acp.AuthPolicy{Methods: []acp.AuthPref{{ID: "factory-api-key", RequiresEnv: "FACTORY_API_KEY"}, {ID: "cached_token"}}},
			map[string]string{"FACTORY_API_KEY": "k"}, "factory-api-key", nil},
		{"requiresEnv empty value counts as unset", "factory-api-key",
			acp.AuthPolicy{Methods: []acp.AuthPref{{ID: "factory-api-key", RequiresEnv: "FACTORY_API_KEY"}}},
			map[string]string{"FACTORY_API_KEY": ""}, "", []string{"needs FACTORY_API_KEY set"}},
		{"listing an interactive-looking id explicitly allows it", "cursor_login",
			acp.AuthPolicy{Methods: []acp.AuthPref{{ID: "cursor_login"}}}, nil, "cursor_login", nil},
		{"skip wins over methods", "cached_token",
			acp.AuthPolicy{Methods: []acp.AuthPref{{ID: "cached_token"}}, Skip: []string{"cached_token"}}, nil, "",
			[]string{"cached_token (skipped)"}},
		{"skip applies to the default order", "cached_token",
			acp.AuthPolicy{Skip: []string{"factory-api-key"}}, nil, "cached_token", nil},
		{"terminal type is never tried even when listed", "term",
			acp.AuthPolicy{Methods: []acp.AuthPref{{ID: "term"}}}, nil, "", []string{"term (terminal login)"}},
		{"env_var type can be listed", "env-thing",
			acp.AuthPolicy{Methods: []acp.AuthPref{{ID: "env-thing"}}}, nil, "env-thing", nil},
		{"unknown preference is reported", "cached_token",
			acp.AuthPolicy{Methods: []acp.AuthPref{{ID: "nope"}}}, nil, "", []string{"nope (not offered by the agent)", "preferred auth methods"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			log := filepath.Join(t.TempDir(), "auth.log")
			env := map[string]string{
				fakeacp.EnvAuthMethods: droidLike, fakeacp.EnvAuthOK: tc.ok, fakeacp.EnvAuthLog: log,
			}
			for k, v := range tc.childEnv {
				env[k] = v
			}
			_, err := runWith(t, env, nil, acp.RunOptions{AuthHint: "see hint", Auth: tc.policy})
			raw, _ := os.ReadFile(log)
			tried := strings.Join(strings.Fields(string(raw)), ",")
			if tried != tc.wantTried {
				t.Errorf("tried = %q, want %q", tried, tc.wantTried)
			}
			if tc.wantErr == nil {
				if err != nil {
					t.Fatalf("err = %v", err)
				}
				return
			}
			if !errors.Is(err, acp.ErrAuthRequired) {
				t.Fatalf("err = %v, want ErrAuthRequired", err)
			}
			for _, s := range append(tc.wantErr, "see hint") {
				if !strings.Contains(err.Error(), s) {
					t.Errorf("error %q lacks %q", err, s)
				}
			}
		})
	}
}
