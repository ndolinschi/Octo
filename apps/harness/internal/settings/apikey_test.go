package settings_test

import (
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/settings"
)

func keyRig(t *testing.T, env map[string]string) (*rig, *[]string) {
	t.Helper()
	r := newRig(t, "", env, nil, nil)
	var keys []string
	app := r.app.applier()
	app.APIKey = func(k string) { keys = append(keys, k) }
	r.m = settings.New(settings.Options{
		DataDir: r.dir, Apply: app, Notify: r.app.notify,
		Lookup: func(k string) (string, bool) { v, ok := r.env[k]; return v, ok },
	})
	return r, &keys
}

// With a process that can swap its key, ANTHROPIC_API_KEY applies at once: the
// key reaches the Applier, nothing waits for a restart, and the view says so.
func TestAPIKeyAppliesAtOnceWhenTheProcessCanSwapIt(t *testing.T) {
	r, keys := keyRig(t, nil)
	if k := r.get(t)["ANTHROPIC_API_KEY"]; k.Applies != "now" {
		t.Fatalf("applies = %q", k.Applies)
	}
	v, err := r.m.Put(settings.Update{Set: map[string]any{"ANTHROPIC_API_KEY": secret}})
	if err != nil {
		t.Fatal(err)
	}
	if len(*keys) != 1 || (*keys)[0] != secret || len(v.RestartRequired) != 0 {
		t.Fatalf("keys %d restart_required %v", len(*keys), v.RestartRequired)
	}
	if strings.Contains(r.file(t), "ANTHROPIC_API_KEY=") == false {
		t.Fatal("key not stored")
	}
	// Removing it tells the Applier the key is gone (the live loop turns off).
	if _, err := r.m.Put(settings.Update{Unset: []string{"ANTHROPIC_API_KEY"}}); err != nil {
		t.Fatal(err)
	}
	if len(*keys) != 2 || (*keys)[1] != "" {
		t.Fatalf("keys = %q", *keys)
	}
	// A value that did not change is not applied again.
	if _, err := r.m.Put(settings.Update{Unset: []string{"ANTHROPIC_API_KEY"}}); err != nil || len(*keys) != 2 {
		t.Fatalf("keys = %q (%v)", *keys, err)
	}
}

// A key from the process environment cannot be changed here, so it is never applied.
func TestAnEnvironmentKeyIsNotAppliedOrEditable(t *testing.T) {
	r, keys := keyRig(t, map[string]string{"ANTHROPIC_API_KEY": secret})
	_, err := r.m.Put(settings.Update{Set: map[string]any{"ANTHROPIC_API_KEY": "other-other-other-key"}})
	wantCode(t, err, "setting_locked")
	if len(*keys) != 0 {
		t.Fatalf("keys = %q", *keys)
	}
}

// Without the hook (an embedder that cannot swap the key) it still needs a restart.
func TestAPIKeyNeedsARestartWithoutTheHook(t *testing.T) {
	r := newRig(t, "", nil, nil, nil)
	if k := r.get(t)["ANTHROPIC_API_KEY"]; k.Applies != "restart" {
		t.Fatalf("applies = %q", k.Applies)
	}
	v, err := r.m.Put(settings.Update{Set: map[string]any{"ANTHROPIC_API_KEY": secret}})
	if err != nil || len(v.RestartRequired) != 1 {
		t.Fatalf("restart_required = %v (%v)", v.RestartRequired, err)
	}
}
