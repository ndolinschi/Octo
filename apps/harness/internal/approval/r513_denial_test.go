package approval

import "testing"

// R5-13: a denial is remembered for the turn across agents, keyed by the
// action, and forgotten when the turn ends or the project is dropped.
func TestDenialIsRememberedForTheTurn(t *testing.T) {
	m := New(func(string, string, map[string]any) {}, nil, 0)
	k := DenialKey("acp:execute", Detail{Command: "echo hello > v2d.txt"}, "echo hello > v2d.txt")
	other := DenialKey("acp:execute", Detail{Command: "echo bye > x.txt"}, "")
	if m.DeniedInTurn("p", 1, k) {
		t.Fatal("denied before any answer")
	}
	m.RememberDenial("p", 1, k)
	if !m.DeniedInTurn("p", 1, k) {
		t.Fatal("the denial was not remembered")
	}
	if m.DeniedInTurn("p", 1, other) || m.DeniedInTurn("p", 2, k) || m.DeniedInTurn("q", 1, k) {
		t.Fatal("a denial leaked to another action, turn or project")
	}
	m.EndTurn("p", 1)
	if m.DeniedInTurn("p", 1, k) {
		t.Fatal("the denial outlived its turn")
	}
	m.RememberDenial("p", 3, k)
	m.Forget("p")
	if m.DeniedInTurn("p", 3, k) {
		t.Fatal("the denial outlived its project")
	}
	m.RememberDenial("p", 4, "")
	if m.DeniedInTurn("p", 4, "") {
		t.Fatal("an empty key was remembered")
	}
	if a, b := DenialKey("acp:edit", Detail{}, "Write a"), DenialKey("acp:edit", Detail{}, "Write b"); a == b {
		t.Fatal("title-only keys collide")
	}
}
