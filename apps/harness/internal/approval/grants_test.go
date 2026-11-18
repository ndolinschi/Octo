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
