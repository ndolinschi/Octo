package childenv_test

import (
	"slices"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/childenv"
)

// Decision 2026-11-12 rule 6: the probe and the agent get the variables a CLI
// needs to find the credential store it reads in a terminal. Each is passed
// when set.
func TestLoginShellVariablesReachChildren(t *testing.T) {
	want := []string{
		"HOME=/home/u", "USER=u", "LOGNAME=u", "PATH=/usr/bin", "SHELL=/bin/zsh", "LANG=en_US.UTF-8", "TMPDIR=/var/folders/x/T/",
		"SSH_AUTH_SOCK=/private/tmp/com.apple.launchd/Listeners", "__CF_USER_TEXT_ENCODING=0x1F5:0x0:0x0",
		"XDG_CONFIG_HOME=/home/u/.config", "XDG_DATA_HOME=/home/u/.local/share", "XDG_STATE_HOME=/home/u/.local/state",
		"XDG_CACHE_HOME=/home/u/.cache", "XDG_RUNTIME_DIR=/run/user/1000",
	}
	got := childenv.ScrubWith(append([]string{"SOME_TOKEN=x", "XAI_API_KEY=k"}, want...), childenv.Allow{})
	for _, kv := range want {
		if !slices.Contains(got, kv) {
			t.Errorf("%s was dropped; the child got %v", kv, got)
		}
	}
	if len(got) != len(want) {
		t.Errorf("secrets passed along: %v", got)
	}
}
