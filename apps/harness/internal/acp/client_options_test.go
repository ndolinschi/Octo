package acp_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakeacp"
)

func runWith(t *testing.T, env map[string]string, args []string, opts acp.RunOptions) (string, error) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	spec := fakeSpec(dir, env)
	spec.Args = args
	c, err := acp.Start(context.Background(), spec)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	h := newRec()
	stop, err := c.RunWith(context.Background(), dir, "go", h, opts)
	if err == nil && stop != acp.StopEndTurn {
		t.Fatalf("stop = %q", stop)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.text.String(), err
}

func TestAuthenticate(t *testing.T) {
	loginFile := filepath.Join(t.TempDir(), "login")
	if err := os.WriteFile(loginFile, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(t.TempDir(), "absent")
	const hint = "Run `fake login` once."
	tests := []struct {
		name    string
		env     map[string]string
		wantErr bool
		contain []string
	}{
		{"unattended method is used", map[string]string{fakeacp.EnvAuth: "ok"}, false, nil},
		{"stored credentials present", map[string]string{fakeacp.EnvAuth: "ok", fakeacp.EnvLoginFile: loginFile}, false, nil},
		{"stored credentials missing", map[string]string{fakeacp.EnvAuth: "ok", fakeacp.EnvLoginFile: missing}, true,
			[]string{fakeacp.AuthUnattended, "not logged in", hint}},
		{"only interactive methods", map[string]string{fakeacp.EnvAuth: "interactive"}, true,
			[]string{"interactive login methods", fakeacp.AuthInteractive, hint}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			text, err := runWith(t, tc.env, nil, acp.RunOptions{AuthHint: hint})
			if !tc.wantErr {
				if err != nil || !strings.Contains(text, "Summary:") {
					t.Fatalf("err = %v, text = %q", err, text)
				}
				return
			}
			if !errors.Is(err, acp.ErrAuthRequired) {
				t.Fatalf("err = %v, want ErrAuthRequired", err)
			}
			for _, s := range tc.contain {
				if !strings.Contains(err.Error(), s) {
					t.Errorf("error %q lacks %q", err, s)
				}
			}
		})
	}
}

func TestModelSelection(t *testing.T) {
	models := "alpha,beta,gamma"
	tests := []struct {
		name    string
		env     map[string]string
		args    []string
		opts    acp.RunOptions
		want    string // "Model in use: X." expected in the text
		wantErr string
	}{
		{"set_model", map[string]string{fakeacp.EnvModels: models}, nil, acp.RunOptions{Model: "beta"}, "Model in use: beta.", ""},
		{"config option", map[string]string{fakeacp.EnvModels: models, fakeacp.EnvModelsVia: "config"}, nil,
			acp.RunOptions{Model: "gamma"}, "Model in use: gamma.", ""},
		{"already current", map[string]string{fakeacp.EnvModels: models}, nil, acp.RunOptions{Model: "alpha"}, "Model in use: alpha.", ""},
		{"no model asked keeps the agent's", map[string]string{fakeacp.EnvModels: models}, nil, acp.RunOptions{}, "Model in use: alpha.", ""},
		{"refused and required", map[string]string{fakeacp.EnvModels: models, fakeacp.EnvRefuseModel: "1"}, nil,
			acp.RunOptions{Model: "nope", ModelRequired: true}, "", "unknown model nope"},
		{"refused default is tolerated", map[string]string{fakeacp.EnvModels: models, fakeacp.EnvRefuseModel: "1"}, nil,
			acp.RunOptions{Model: "nope"}, "Model in use: alpha.", ""},
		{"config option refuses an id it does not offer", map[string]string{fakeacp.EnvModels: models, fakeacp.EnvModelsVia: "config", fakeacp.EnvRefuseModel: "1"}, nil,
			acp.RunOptions{Model: "nope", ModelRequired: true}, "", "the agent offers alpha, beta, gamma"},
		{"config option accepts a typed id it does not list", map[string]string{fakeacp.EnvModels: models, fakeacp.EnvModelsVia: "config"}, nil,
			acp.RunOptions{Model: "typed-1", ModelRequired: true}, "Model in use: typed-1.", ""},
		{"set_model accepts a typed id it does not list", map[string]string{fakeacp.EnvModels: models}, nil,
			acp.RunOptions{Model: "typed-1", ModelRequired: true}, "Model in use: typed-1.", ""},
		{"grouped config option", map[string]string{fakeacp.EnvModels: models, fakeacp.EnvModelsVia: "config-grouped"}, nil,
			acp.RunOptions{Model: "gamma", ModelRequired: true}, "Model in use: gamma.", ""},
		{"models in _meta", map[string]string{fakeacp.EnvModels: models, fakeacp.EnvModelsVia: "meta"}, nil,
			acp.RunOptions{Model: "beta", ModelRequired: true}, "Model in use: beta.", ""},
		{"models as a bare array", map[string]string{fakeacp.EnvModels: models, fakeacp.EnvModelsVia: "models-array"}, nil,
			acp.RunOptions{Model: "beta", ModelRequired: true}, "Model in use: beta.", ""},
		{"agent lists nothing but takes set_model", map[string]string{fakeacp.EnvModels: models, fakeacp.EnvModelsVia: "none"}, nil,
			acp.RunOptions{Model: "beta", ModelRequired: true}, "Model in use: beta.", ""},
		{"agent advertises nothing and refuses, required", map[string]string{fakeacp.EnvRefuseModel: "1"}, nil,
			acp.RunOptions{Model: "x", ModelRequired: true}, "", "unknown model x"},
		{"agent advertises nothing, optional", nil, nil, acp.RunOptions{Model: "x"}, "Summary:", ""},
		{"start-up argument is enough", nil, []string{"--model", "x"}, acp.RunOptions{Model: "x", ModelRequired: true, ModelApplied: true},
			"Model in use: x.", ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			text, err := runWith(t, tc.env, tc.args, tc.opts)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("err = %v, want %q", err, tc.wantErr)
				}
				return
			}
			if err != nil || !strings.Contains(text, tc.want) {
				t.Fatalf("err = %v, text = %q, want %q", err, text, tc.want)
			}
		})
	}
}

func TestAuthThenModel(t *testing.T) {
	env := map[string]string{fakeacp.EnvAuth: "ok", fakeacp.EnvModels: "a,b", fakeacp.EnvModelsVia: "config"}
	text, err := runWith(t, env, nil, acp.RunOptions{Model: "b", ModelRequired: true})
	if err != nil || !strings.Contains(text, "Model in use: b.") {
		t.Fatalf("err = %v, text = %q", err, text)
	}
}
