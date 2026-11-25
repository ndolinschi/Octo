package settings_test

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/settings"
)

const secret = "sk-or-v1-SECRETSECRETSECRET0123456789wxyz"

type applied struct {
	mu     sync.Mutex
	models [][4]string
	allow  []string
	events [][]string
}

func (a *applied) applier() settings.Applier {
	return settings.Applier{
		Models: func(o, f, b, d string) {
			a.mu.Lock()
			defer a.mu.Unlock()
			a.models = append(a.models, [4]string{o, f, b, d})
		},
		ChildEnvAllow: func(spec string) {
			a.mu.Lock()
			defer a.mu.Unlock()
			a.allow = append(a.allow, spec)
		},
	}
}

func (a *applied) notify(ids []string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.events = append(a.events, slices.Clone(ids))
}

type rig struct {
	dir string
	env map[string]string
	app *applied
	m   *settings.Manager
}

func newRig(t *testing.T, fileContent string, env map[string]string, fromFile []string, validate func(*config.Models) error) *rig {
	t.Helper()
	r := &rig{dir: t.TempDir(), env: env, app: &applied{}}
	if r.env == nil {
		r.env = map[string]string{}
	}
	if fileContent != "" {
		if err := os.WriteFile(filepath.Join(r.dir, config.EnvFileName), []byte(fileContent), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	r.m = settings.New(settings.Options{
		DataDir: r.dir, FromFile: fromFile, ValidateModels: validate, Apply: r.app.applier(), Notify: r.app.notify,
		Lookup: func(k string) (string, bool) { v, ok := r.env[k]; return v, ok },
	})
	return r
}

func (r *rig) get(t *testing.T) map[string]settings.Setting {
	t.Helper()
	v, err := r.m.Get()
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]settings.Setting{}
	for _, s := range v.Settings {
		out[s.ID] = s
	}
	return out
}

func (r *rig) file(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(r.dir, config.EnvFileName))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	return string(b)
}

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	var se *settings.Error
	if !errors.As(err, &se) || se.Code != code {
		t.Fatalf("err = %v, want code %s", err, code)
	}
}

func TestGetListsEverySettingWithDefaults(t *testing.T) {
	r := newRig(t, "", nil, nil, nil)
	v, err := r.m.Get()
	if err != nil {
		t.Fatal(err)
	}
	if got := len(v.Settings); got != len(settings.IDs()) || len(v.RestartRequired) != 0 || v.RestartRequired == nil {
		t.Fatalf("view = %+v", v)
	}
	s := r.get(t)
	b := config.BuiltinModels()
	if m := s["HARNESS_MODEL_ORCHESTRATOR"]; m.Kind != "model" || m.Group != "models" || m.Value != b.Orchestrator ||
		m.Source != "default" || m.Applies != "now" || !m.Editable || m.Set {
		t.Fatalf("orchestrator = %+v", m)
	}
	if k := s["ANTHROPIC_API_KEY"]; k.Kind != "secret" || k.Group != "keys" || k.Set || k.Value != nil || k.Applies != "restart" {
		t.Fatalf("key = %+v", k)
	}
	if e := s["OCTO_ROUTER_ENABLED"]; e.Kind != "bool" || e.Group != "router" || e.Value != false {
		t.Fatalf("enabled = %+v", e)
	}
	if u := s["OCTO_ROUTER_BASE_URL"]; u.Kind != "text" || u.Value != nil || u.Set {
		t.Fatalf("base url = %+v", u)
	}
	if l := s["HARNESS_CHILD_ENV_ALLOW"]; l.Kind != "list" || l.Group != "advanced" || l.Applies != "now" {
		t.Fatalf("allow = %+v", l)
	}
	raw, _ := json.Marshal(v)
	if strings.Contains(string(raw), `"value":null`) {
		t.Fatalf("null values on the wire: %s", raw)
	}
}

func TestRoundTripNeverReturnsTheSecret(t *testing.T) {
	r := newRig(t, "# keep\nOTHER=1\n", nil, nil, nil)
	view, err := r.m.Put(settings.Update{Set: map[string]any{
		"ANTHROPIC_API_KEY": secret, "OCTO_ROUTER_UPSTREAM_KEY": "short-key",
		"OCTO_ROUTER_ENABLED": true, "OCTO_ROUTER_BASE_URL": "https://router.example:8080/autoroute",
		"HARNESS_CHILD_ENV_ALLOW": []any{"MY_TOOL_*", "AWS_PROFILE"},
		"HARNESS_MODEL_FAST":      "openrouter/anthropic/claude-haiku",
	}})
	if err != nil {
		t.Fatal(err)
	}
	for name, v := range map[string]settings.View{"put": view, "get": mustGet(t, r)} {
		raw, _ := json.Marshal(v)
		if strings.Contains(string(raw), "SECRETSECRET") || strings.Contains(string(raw), "short-key") {
			t.Fatalf("%s leaked a secret: %s", name, raw)
		}
		s := map[string]settings.Setting{}
		for _, x := range v.Settings {
			s[x.ID] = x
		}
		if k := s["ANTHROPIC_API_KEY"]; !k.Set || k.Source != "file" || k.Hint != "…wxyz" || k.Value != nil || !k.Editable {
			t.Fatalf("%s key = %+v", name, k)
		}
		if k := s["OCTO_ROUTER_UPSTREAM_KEY"]; !k.Set || k.Hint != "" {
			t.Fatalf("%s short key must give no hint: %+v", name, k)
		}
		if e := s["OCTO_ROUTER_ENABLED"]; e.Value != true || !e.Set || e.Source != "file" {
			t.Fatalf("%s enabled = %+v", name, e)
		}
		if l := s["HARNESS_CHILD_ENV_ALLOW"]; !slices.Equal(l.Value.([]string), []string{"MY_TOOL_*", "AWS_PROFILE"}) {
			t.Fatalf("%s allow = %+v", name, l)
		}
	}
	f := r.file(t)
	if !strings.HasPrefix(f, "# keep\nOTHER=1\n") || !strings.Contains(f, "OCTO_ROUTER_ENABLED=1\n") ||
		!strings.Contains(f, "HARNESS_CHILD_ENV_ALLOW=MY_TOOL_*,AWS_PROFILE\n") {
		t.Fatalf("file = %q", f)
	}
	if runtime.GOOS != "windows" {
		fi, _ := os.Stat(filepath.Join(r.dir, config.EnvFileName))
		if fi.Mode().Perm() != 0o600 {
			t.Fatalf("mode = %v", fi.Mode())
		}
	}

	// Unset restores defaults and removes lines; unknown lines stay.
	view, err = r.m.Put(settings.Update{Unset: []string{"ANTHROPIC_API_KEY", "HARNESS_MODEL_FAST", "OCTO_ROUTER_ENABLED"}})
	if err != nil {
		t.Fatal(err)
	}
	if k := byID(view, "ANTHROPIC_API_KEY"); k.Set || k.Source != "default" {
		t.Fatalf("key after unset = %+v", k)
	}
	if m := byID(view, "HARNESS_MODEL_FAST"); m.Value != config.BuiltinModels().Fast || m.Source != "default" {
		t.Fatalf("fast after unset = %+v", m)
	}
	if f := r.file(t); strings.Contains(f, "ANTHROPIC_API_KEY") || !strings.Contains(f, "OTHER=1") {
		t.Fatalf("file = %q", f)
	}
}

func mustGet(t *testing.T, r *rig) settings.View {
	t.Helper()
	v, err := r.m.Get()
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func byID(v settings.View, id string) settings.Setting {
	for _, s := range v.Settings {
		if s.ID == id {
			return s
		}
	}
	return settings.Setting{}
}

func TestEnvironmentWinsAndIsNotEditable(t *testing.T) {
	// ANTHROPIC_API_KEY and FAST come from the process environment; ROUTER URL
	// was loaded from the file at start.
	r := newRig(t, "OCTO_ROUTER_BASE_URL=http://file:1\nHARNESS_MODEL_FAST=from-file\n",
		map[string]string{"ANTHROPIC_API_KEY": secret, "HARNESS_MODEL_FAST": "from-env", "OCTO_ROUTER_BASE_URL": "http://file:1"},
		[]string{"OCTO_ROUTER_BASE_URL"}, nil)
	s := r.get(t)
	if k := s["ANTHROPIC_API_KEY"]; k.Source != "environment" || k.Editable || !k.Set || k.Value != nil || k.Hint != "…wxyz" {
		t.Fatalf("key = %+v", k)
	}
	if m := s["HARNESS_MODEL_FAST"]; m.Source != "environment" || m.Editable || m.Value != "from-env" {
		t.Fatalf("fast = %+v (the file cannot override the environment)", m)
	}
	if u := s["OCTO_ROUTER_BASE_URL"]; u.Source != "file" || !u.Editable || u.Value != "http://file:1" {
		t.Fatalf("url = %+v", u)
	}
	before := r.file(t)
	for name, u := range map[string]settings.Update{
		"set":   {Set: map[string]any{"HARNESS_MODEL_FAST": "x"}},
		"unset": {Unset: []string{"ANTHROPIC_API_KEY"}},
	} {
		if _, err := r.m.Put(u); err == nil {
			t.Fatalf("%s of an environment setting accepted", name)
		} else {
			wantCode(t, err, "setting_locked")
		}
	}
	if r.file(t) != before {
		t.Fatal("file changed")
	}
}

func TestEmptyEnvironmentVariableStillLocksTheSetting(t *testing.T) {
	r := newRig(t, "", map[string]string{"ANTHROPIC_API_KEY": ""}, nil, nil)
	if k := r.get(t)["ANTHROPIC_API_KEY"]; k.Source != "environment" || k.Editable || k.Set {
		t.Fatalf("key = %+v", k)
	}
}

func TestValidationHappensBeforeAnyWrite(t *testing.T) {
	r := newRig(t, "OTHER=1\n", nil, nil, func(m *config.Models) error {
		if strings.HasPrefix(m.Deep, "acp:") {
			return errors.New("models.deep: no such agent")
		}
		return nil
	})
	bad := map[string]settings.Update{
		"unknown id":        {Set: map[string]any{"NOPE": "x"}},
		"unknown unset":     {Unset: []string{"NOPE"}},
		"both":              {Set: map[string]any{"HARNESS_MODEL_FAST": "a"}, Unset: []string{"HARNESS_MODEL_FAST"}},
		"empty update":      {},
		"empty secret":      {Set: map[string]any{"ANTHROPIC_API_KEY": "   "}},
		"newline secret":    {Set: map[string]any{"ANTHROPIC_API_KEY": "abc\ndef"}},
		"quote secret":      {Set: map[string]any{"ANTHROPIC_API_KEY": `"abc`}},
		"long secret":       {Set: map[string]any{"ANTHROPIC_API_KEY": strings.Repeat("a", 513)}},
		"secret not string": {Set: map[string]any{"ANTHROPIC_API_KEY": 5.0}},
		"bool as string":    {Set: map[string]any{"OCTO_ROUTER_ENABLED": "1"}},
		"model blank":       {Set: map[string]any{"HARNESS_MODEL_FAST": ""}},
		"model spaces":      {Set: map[string]any{"HARNESS_MODEL_FAST": "a b"}},
		"model acp":         {Set: map[string]any{"HARNESS_MODEL_DEEP": "acp:ghost"}},
		"url scheme":        {Set: map[string]any{"OCTO_ROUTER_BASE_URL": "ftp://x"}},
		"url creds":         {Set: map[string]any{"OCTO_ROUTER_BASE_URL": "http://u:p@x"}},
		"url query":         {Set: map[string]any{"OCTO_ROUTER_BASE_URL": "http://x/?k=1"}},
		"list not list":     {Set: map[string]any{"HARNESS_CHILD_ENV_ALLOW": "A,B"}},
		"list bare star":    {Set: map[string]any{"HARNESS_CHILD_ENV_ALLOW": []any{"*"}}},
		"list bad name":     {Set: map[string]any{"HARNESS_CHILD_ENV_ALLOW": []any{"A B"}}},
	}
	for name, u := range bad {
		// The valid item in the same request must not be written either.
		if u.Set != nil {
			if _, has := u.Set["OCTO_ROUTER_ENABLED"]; !has {
				u.Set["OCTO_ROUTER_ENABLED"] = true
			}
		}
		_, err := r.m.Put(u)
		var se *settings.Error
		if !errors.As(err, &se) {
			t.Errorf("%s: err = %v, want a validation error", name, err)
			continue
		}
		if strings.Contains(se.Message, "abc") {
			t.Errorf("%s: message echoes the value: %s", name, se.Message)
		}
		if got := r.file(t); got != "OTHER=1\n" {
			t.Fatalf("%s: file written: %q", name, got)
		}
	}
	if len(r.app.models)+len(r.app.allow)+len(r.app.events) != 0 {
		t.Fatalf("something was applied or announced: %+v", r.app)
	}
	if _, err := r.m.Put(settings.Update{Set: map[string]any{"NOPE": "x"}}); err != nil {
		wantCode(t, err, "unknown_setting")
	}
}

func TestEmptyTextAndListMeanUnset(t *testing.T) {
	r := newRig(t, "OCTO_ROUTER_BASE_URL=http://a:1\nHARNESS_CHILD_ENV_ALLOW=X\n", nil, nil, nil)
	if _, err := r.m.Put(settings.Update{Set: map[string]any{"OCTO_ROUTER_BASE_URL": "", "HARNESS_CHILD_ENV_ALLOW": []any{}}}); err != nil {
		t.Fatal(err)
	}
	if f := r.file(t); f != "" {
		t.Fatalf("file = %q", f)
	}
}

func TestRestartRequiredTracksTheValueTheProcessStartedWith(t *testing.T) {
	r := newRig(t, "ANTHROPIC_API_KEY=oldoldoldoldoldoldold\n", map[string]string{"ANTHROPIC_API_KEY": "oldoldoldoldoldoldold"}, []string{"ANTHROPIC_API_KEY"}, nil)
	if v := mustGet(t, r); len(v.RestartRequired) != 0 {
		t.Fatalf("fresh start: %v", v.RestartRequired)
	}
	v, err := r.m.Put(settings.Update{Set: map[string]any{"ANTHROPIC_API_KEY": "newnewnewnewnewnewnew", "OCTO_ROUTER_ENABLED": true}})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(v.RestartRequired, []string{"ANTHROPIC_API_KEY", "OCTO_ROUTER_ENABLED"}) {
		t.Fatalf("restart_required = %v", v.RestartRequired)
	}
	// Apply-now settings never appear.
	v, _ = r.m.Put(settings.Update{Set: map[string]any{"HARNESS_MODEL_FAST": "m1"}})
	if slices.Contains(v.RestartRequired, "HARNESS_MODEL_FAST") {
		t.Fatalf("apply-now listed: %v", v.RestartRequired)
	}
	// Putting the original value back needs no restart any more.
	v, _ = r.m.Put(settings.Update{Set: map[string]any{"ANTHROPIC_API_KEY": "oldoldoldoldoldoldold"}, Unset: []string{"OCTO_ROUTER_ENABLED"}})
	if len(v.RestartRequired) != 0 {
		t.Fatalf("restart_required = %v after reverting", v.RestartRequired)
	}
}

func TestApplyNowSwapsModelsAndAllowListAndAnnouncesIdsOnly(t *testing.T) {
	r := newRig(t, "", nil, nil, nil)
	b := config.BuiltinModels()
	if _, err := r.m.Put(settings.Update{Set: map[string]any{
		"HARNESS_MODEL_ORCHESTRATOR": "acp:claude-code", "HARNESS_CHILD_ENV_ALLOW": []any{"MY_*"}, "ANTHROPIC_API_KEY": secret,
	}}); err != nil {
		t.Fatal(err)
	}
	if len(r.app.models) != 1 || r.app.models[0] != [4]string{"acp:claude-code", b.Fast, b.Balanced, b.Deep} {
		t.Fatalf("models = %v", r.app.models)
	}
	if len(r.app.allow) != 1 || r.app.allow[0] != "MY_*" {
		t.Fatalf("allow = %v", r.app.allow)
	}
	if len(r.app.events) != 1 {
		t.Fatalf("events = %v", r.app.events)
	}
	if ids := slices.Sorted(slices.Values(r.app.events[0])); !slices.Equal(ids, []string{"ANTHROPIC_API_KEY", "HARNESS_CHILD_ENV_ALLOW", "HARNESS_MODEL_ORCHESTRATOR"}) {
		t.Fatalf("event ids = %v", ids)
	}
	// A request that changes nothing announces nothing and applies nothing.
	if _, err := r.m.Put(settings.Update{Set: map[string]any{"HARNESS_MODEL_ORCHESTRATOR": "acp:claude-code"}}); err != nil {
		t.Fatal(err)
	}
	if len(r.app.events) != 1 || len(r.app.models) != 1 {
		t.Fatalf("no-op announced: %+v", r.app)
	}
	// Unset falls back to the built-in model and clears the allow list.
	if _, err := r.m.Put(settings.Update{Unset: []string{"HARNESS_MODEL_ORCHESTRATOR", "HARNESS_CHILD_ENV_ALLOW"}}); err != nil {
		t.Fatal(err)
	}
	if last := r.app.models[len(r.app.models)-1]; last != [4]string{b.Orchestrator, b.Fast, b.Balanced, b.Deep} {
		t.Fatalf("models after unset = %v", last)
	}
	if last := r.app.allow[len(r.app.allow)-1]; last != "" {
		t.Fatalf("allow after unset = %q", last)
	}
}

func TestApplyNowKeepsEnvironmentModelsWhenAnotherTierChanges(t *testing.T) {
	r := newRig(t, "", map[string]string{"HARNESS_MODEL_DEEP": "env-deep"}, nil, nil)
	if _, err := r.m.Put(settings.Update{Set: map[string]any{"HARNESS_MODEL_FAST": "f"}}); err != nil {
		t.Fatal(err)
	}
	b := config.BuiltinModels()
	if got := r.app.models[0]; got != [4]string{b.Orchestrator, "f", b.Balanced, "env-deep"} {
		t.Fatalf("models = %v", got)
	}
}

func TestModelValidationUsesTheProjectValidator(t *testing.T) {
	var seen []config.Models
	r := newRig(t, "", nil, nil, func(m *config.Models) error { seen = append(seen, *m); return nil })
	if _, err := r.m.Put(settings.Update{Set: map[string]any{"HARNESS_MODEL_BALANCED": "acp:codex/gpt-5"}}); err != nil {
		t.Fatal(err)
	}
	if len(seen) != 1 || seen[0].Balanced != "acp:codex/gpt-5" || seen[0].Fast != "" {
		t.Fatalf("validator saw %+v", seen)
	}
}

func TestInvalidValueInTheFileIsIgnoredWithAHint(t *testing.T) {
	r := newRig(t, "OCTO_ROUTER_ENABLED=maybe\n", nil, nil, nil)
	if e := r.get(t)["OCTO_ROUTER_ENABLED"]; e.Set || e.Value != false || e.Hint == "" || e.Source != "default" {
		t.Fatalf("enabled = %+v", e)
	}
}

func TestLooseFileModeIsShownAndRepairedByAPut(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no mode bits")
	}
	r := newRig(t, "OCTO_ROUTER_ENABLED=1\n", nil, nil, nil)
	p := filepath.Join(r.dir, config.EnvFileName)
	if err := os.Chmod(p, 0o644); err != nil {
		t.Fatal(err)
	}
	// The loader ignored the file at start (nothing from it is in the
	// environment), so the value is pending a restart.
	if v := mustGet(t, r); !slices.Equal(v.RestartRequired, []string{"OCTO_ROUTER_ENABLED"}) {
		t.Fatalf("restart_required = %v", v.RestartRequired)
	}
	if _, err := r.m.Put(settings.Update{Set: map[string]any{"OCTO_ROUTER_BASE_URL": "http://x:1"}}); err != nil {
		t.Fatal(err)
	}
	if fi, _ := os.Stat(p); fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v", fi.Mode())
	}
}

// go test -race: PUTs, GETs and the apply callbacks run together.
func TestConcurrentGetAndPut(t *testing.T) {
	r := newRig(t, "", nil, nil, nil)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(2)
		go func(i int) {
			defer wg.Done()
			for j := 0; j < 20; j++ {
				val := "m" + string(rune('a'+i))
				if _, err := r.m.Put(settings.Update{Set: map[string]any{"HARNESS_MODEL_FAST": val, "OCTO_ROUTER_ENABLED": j%2 == 0}}); err != nil {
					t.Error(err)
					return
				}
			}
		}(i)
		go func() {
			defer wg.Done()
			for j := 0; j < 20; j++ {
				if _, err := r.m.Get(); err != nil {
					t.Error(err)
					return
				}
			}
		}()
	}
	wg.Wait()
	if f := r.file(t); strings.Count(f, "HARNESS_MODEL_FAST=") != 1 || strings.Count(f, "OCTO_ROUTER_ENABLED=") != 1 {
		t.Fatalf("file = %q", f)
	}
}

func TestNoteExplainsLockedKeyWhileRouterIsOn(t *testing.T) {
	env := map[string]string{"ANTHROPIC_API_KEY": secret}
	on := newRig(t, "OCTO_ROUTER_ENABLED=1\n", env, nil, nil)
	if k := on.get(t)["ANTHROPIC_API_KEY"]; k.Editable || k.Note != settings.RouterNote {
		t.Fatalf("key = %+v", k)
	}
	if u := on.get(t)["OCTO_ROUTER_UPSTREAM_KEY"]; u.Group != "router" || u.Applies != "restart" || u.Note != "" {
		t.Fatalf("upstream = %+v", u)
	}
	off := newRig(t, "OCTO_ROUTER_ENABLED=0\n", env, nil, nil)
	if k := off.get(t)["ANTHROPIC_API_KEY"]; k.Note != "" {
		t.Fatalf("note without router: %+v", k)
	}
	free := newRig(t, "OCTO_ROUTER_ENABLED=1\n", nil, nil, nil)
	if k := free.get(t)["ANTHROPIC_API_KEY"]; k.Note != "" || !k.Editable {
		t.Fatalf("editable key got a note: %+v", k)
	}
}

func TestOllamaSettingsAndApply(t *testing.T) {
	var gotURL, gotModel string
	r := newRig(t, "", nil, nil, nil)
	m := r.get(t)["HARNESS_MODEL_COMPLETION"]
	if m.Kind != "model" || m.Group != "models" || m.Value != config.DefaultOllamaSmallModel {
		t.Fatalf("completion setting = %+v", m)
	}
	r2 := settings.New(settings.Options{
		DataDir: r.dir,
		Apply: settings.Applier{
			Ollama: func(baseURL, model string) { gotURL, gotModel = baseURL, model },
		},
	})
	if _, err := r2.Put(settings.Update{Set: map[string]any{"HARNESS_OLLAMA_BASE_URL": "not-a-url"}}); err == nil {
		t.Fatal("expected invalid URL error")
	}
	if _, err := r2.Put(settings.Update{Set: map[string]any{
		"HARNESS_OLLAMA_BASE_URL":  "http://127.0.0.1:11435",
		"HARNESS_MODEL_COMPLETION": "qwen2.5-coder:3b",
	}}); err != nil {
		t.Fatal(err)
	}
	if gotURL != "http://127.0.0.1:11435" || gotModel != "qwen2.5-coder:3b" {
		t.Fatalf("applied = (%q, %q)", gotURL, gotModel)
	}
	if _, err := r2.Put(settings.Update{Unset: []string{"HARNESS_OLLAMA_BASE_URL", "HARNESS_MODEL_COMPLETION"}}); err != nil {
		t.Fatal(err)
	}
	if gotURL != config.DefaultOllamaBaseURL || gotModel != "" {
		t.Fatalf("after unset = (%q, %q)", gotURL, gotModel)
	}
}

func TestFeatureAutoMemoryDefaultAndApply(t *testing.T) {
	r := newRig(t, "", nil, nil, nil)
	s := r.get(t)[settings.IDFeatureAutoMemory]
	if s.Kind != settings.KindBool || s.Group != settings.GroupAdvanced || s.Applies != settings.AppliesNow || s.Value != true || s.Set {
		t.Fatalf("feature setting = %+v", s)
	}
	var calls []bool
	r2 := settings.New(settings.Options{
		DataDir: r.dir,
		Apply: settings.Applier{
			Features: func(id string, on bool) {
				if id == "auto_memory" {
					calls = append(calls, on)
				}
			},
		},
	})
	v, err := r2.Put(settings.Update{Set: map[string]any{settings.IDFeatureAutoMemory: false}})
	if err != nil {
		t.Fatal(err)
	}
	if byID(v, settings.IDFeatureAutoMemory).Value != false {
		t.Fatalf("after false = %+v", byID(v, settings.IDFeatureAutoMemory))
	}
	v, err = r2.Put(settings.Update{Unset: []string{settings.IDFeatureAutoMemory}})
	if err != nil {
		t.Fatal(err)
	}
	if byID(v, settings.IDFeatureAutoMemory).Value != true {
		t.Fatalf("after unset = %+v", byID(v, settings.IDFeatureAutoMemory))
	}
	if !slices.Equal(calls, []bool{false, true}) {
		t.Fatalf("feature applier calls = %v, want [false true]", calls)
	}
}
