package plugins_test

import (
	"context"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
)

func TestAgentManifestAdditions(t *testing.T) {
	tests := []struct {
		name    string
		agent   string
		wantErr string // substring of the plugin error; empty = loads cleanly
	}{
		{"old manifest", `{"id":"a","command":"sh"}`, ""},
		{"full", `{"id":"a","command":"sh","models":["m1","vendor/m-2"],"defaultModel":"m1","modelArg":["-m","{model}"],
		  "auth":{"probe":["sh","-c","true"],"hint":"run login"},"env":{"T":"${HOME}","X":"literal"}}`, ""},
		{"hint only", `{"id":"a","command":"sh","auth":{"hint":"log in first"}}`, ""},
		{"default without list", `{"id":"a","command":"sh","defaultModel":"m1"}`, ""},
		{"default not listed", `{"id":"a","command":"sh","models":["m1"],"defaultModel":"m2"}`, "defaultModel"},
		{"duplicate model", `{"id":"a","command":"sh","models":["m1","m1"]}`, "duplicate model"},
		{"flag-like model", `{"id":"a","command":"sh","models":["-rf"]}`, "must match"},
		{"model with space", `{"id":"a","command":"sh","models":["a b"]}`, "must match"},
		{"modelArg without placeholder", `{"id":"a","command":"sh","modelArg":["-m","fixed"]}`, "{model}"},
		{"methods in both forms", `{"id":"a","command":"sh","auth":{"hint":"h","methods":["cached_token",{"id":"k","requiresEnv":"K_API_KEY"}],"skip":["device-pairing"]}}`, ""},
		{"method object without id", `{"id":"a","command":"sh","auth":{"hint":"h","methods":[{"requiresEnv":"K"}]}}`, "id is required"},
		{"duplicate method", `{"id":"a","command":"sh","auth":{"hint":"h","methods":["x","x"]}}`, "duplicate id"},
		{"bad requiresEnv", `{"id":"a","command":"sh","auth":{"hint":"h","methods":[{"id":"x","requiresEnv":"A=B"}]}}`, "requiresEnv"},
		{"empty skip id", `{"id":"a","command":"sh","auth":{"hint":"h","skip":[""]}}`, "auth.skip"},
		{"modelArgs placeholder", `{"id":"a","command":"sh","args":["agent","{modelArgs}","stdio"],"modelArg":["-m","{model}"]}`, ""},
		{"modelArgs without modelArg", `{"id":"a","command":"sh","args":["agent","{modelArgs}"]}`, "modelArg is not set"},
		{"modelArgs twice", `{"id":"a","command":"sh","args":["{modelArgs}","{modelArgs}"],"modelArg":["-m","{model}"]}`, "only once"},
		{"flatRate and strengths", `{"id":"a","command":"sh","flatRate":true,"strengths":["easy","hard"]}`, ""},
		{"bad strength", `{"id":"a","command":"sh","strengths":["trivial"]}`, "strengths"},
		{"duplicate strength", `{"id":"a","command":"sh","strengths":["easy","easy"]}`, "duplicate"},
		{"empty auth", `{"id":"a","command":"sh","auth":{}}`, "auth needs"},
		{"blank probe command", `{"id":"a","command":"sh","auth":{"probe":[" "]}}`, "probe[0]"},
		{"malformed env ref", `{"id":"a","command":"sh","env":{"T":"${HOME"}}`, "malformed"},
		{"bad env name", `{"id":"a","command":"sh","env":{"A=B":"x"}}`, "variable name"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			data := t.TempDir()
			writePlugin(t, filepath.Join(data, "plugins"), "p", `{"name":"p","version":"1","agents":[`+tc.agent+`]}`)
			r := plugins.Load(context.Background(), data, nil, nil)
			p := find(t, r, "p")
			if tc.wantErr == "" {
				if len(p.Errors) != 0 || len(p.Agents) != 1 {
					t.Fatalf("plugin = %+v", p)
				}
				if p.Agents[0].Models == nil {
					t.Error("models must be an empty list, not nil")
				}
				return
			}
			if len(p.Agents) != 0 || len(p.Errors) != 1 || !strings.Contains(p.Errors[0], tc.wantErr) {
				t.Fatalf("plugin = %+v, want one error containing %q", p, tc.wantErr)
			}
		})
	}
}

func TestAgentFieldsLoaded(t *testing.T) {
	data := t.TempDir()
	writePlugin(t, filepath.Join(data, "plugins"), "p", `{"name":"p","version":"1","agents":[
	  {"id":"a","command":"sh","models":["m1","m2"],"defaultModel":"m2","modelArg":["--model={model}"],
	   "auth":{"probe":["sh","-c","exit 0"],"hint":"  run login  "}}]}`)
	a, _ := plugins.Load(context.Background(), data, nil, nil).Agent("a")
	if !reflect.DeepEqual(a.Models, []string{"m1", "m2"}) || a.DefaultModel != "m2" || a.Hint != "run login" ||
		!a.Available || a.LoggedIn != nil || filepath.Base(a.ProbeCommand) != "sh" || !reflect.DeepEqual(a.ProbeArgs, []string{"-c", "exit 0"}) {
		t.Fatalf("agent = %+v", a)
	}
}

func TestArgsFor(t *testing.T) {
	tests := []struct {
		name  string
		agent plugins.Agent
		model string
		want  []string
	}{
		{"no model", plugins.Agent{Launch: plugins.Launch{Args: []string{"agent", "stdio"}}, ModelArg: []string{"-m", "{model}"}}, "", []string{"agent", "stdio"}},
		{"template", plugins.Agent{Launch: plugins.Launch{Args: []string{"agent"}}, ModelArg: []string{"-m", "{model}"}}, "x-1", []string{"agent", "-m", "x-1"}},
		{"joined", plugins.Agent{ModelArg: []string{"--model={model}"}}, "x", []string{"--model=x"}},
		{"placeholder in the middle", plugins.Agent{Launch: plugins.Launch{Args: []string{"agent", "{modelArgs}", "stdio"}}, ModelArg: []string{"-m", "{model}"}}, "g-1",
			[]string{"agent", "-m", "g-1", "stdio"}},
		{"placeholder removed without a model", plugins.Agent{Launch: plugins.Launch{Args: []string{"agent", "{modelArgs}", "stdio"}}, ModelArg: []string{"-m", "{model}"}}, "",
			[]string{"agent", "stdio"}},
		{"placeholder first", plugins.Agent{Launch: plugins.Launch{Args: []string{"{modelArgs}", "acp"}}, ModelArg: []string{"--model={model}"}}, "x",
			[]string{"--model=x", "acp"}},
		{"placeholder without template is dropped", plugins.Agent{Launch: plugins.Launch{Args: []string{"a", "{modelArgs}"}}}, "x", []string{"a"}},
		{"no template", plugins.Agent{Launch: plugins.Launch{Args: []string{"a"}}}, "x", []string{"a"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := tc.agent.ArgsFor(tc.model)
			if len(got) == 0 && len(tc.want) == 0 {
				return
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("ArgsFor(%q) = %v, want %v", tc.model, got, tc.want)
			}
		})
	}
}

func TestAuthPolicyLoaded(t *testing.T) {
	data := t.TempDir()
	writePlugin(t, filepath.Join(data, "plugins"), "p", `{"name":"p","version":"1","agents":[
	  {"id":"a","command":"sh","auth":{"hint":"h","methods":["cached_token",{"id":"k","requiresEnv":"K_API_KEY"}],"skip":["device-pairing"]}}]}`)
	a, _ := plugins.Load(context.Background(), data, nil, nil).Agent("a")
	want := []plugins.AuthMethodRef{{ID: "cached_token"}, {ID: "k", RequiresEnv: "K_API_KEY"}}
	if !reflect.DeepEqual(a.AuthMethods, want) || !reflect.DeepEqual(a.AuthSkip, []string{"device-pairing"}) {
		t.Fatalf("agent = %+v", a)
	}
}

func TestResolvedEnv(t *testing.T) {
	t.Setenv("OCTO_T_SET", "secret")
	t.Setenv("OCTO_T_EMPTY", "")
	t.Setenv("OCTO_T_OTHER", "two")
	tests := []struct {
		name string
		env  map[string]string
		want map[string]string
	}{
		{"literal", map[string]string{"A": "plain"}, map[string]string{"A": "plain"}},
		{"set", map[string]string{"A": "${OCTO_T_SET}"}, map[string]string{"A": "secret"}},
		{"renamed", map[string]string{"CODEX_HOME": "${OCTO_T_SET}"}, map[string]string{"CODEX_HOME": "secret"}},
		{"missing is unset", map[string]string{"A": "${OCTO_T_NOPE}", "B": "ok"}, map[string]string{"B": "ok"}},
		{"empty counts as missing", map[string]string{"A": "${OCTO_T_EMPTY}"}, map[string]string{}},
		{"embedded", map[string]string{"A": "x-${OCTO_T_SET}-${OCTO_T_OTHER}"}, map[string]string{"A": "x-secret-two"}},
		{"partly missing drops it", map[string]string{"A": "${OCTO_T_SET}${OCTO_T_NOPE}"}, map[string]string{}},
		{"dollar without braces", map[string]string{"A": "$OCTO_T_SET"}, map[string]string{"A": "$OCTO_T_SET"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := plugins.Launch{Env: tc.env}.ResolvedEnv()
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("ResolvedEnv = %v, want %v", got, tc.want)
			}
		})
	}
}
