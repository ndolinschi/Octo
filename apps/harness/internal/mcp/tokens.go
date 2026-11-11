package mcp

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"sync"
)

// Binding is what a token grants access to: one project's orchestrator agent.
type Binding struct {
	ProjectID string
	// AgentID is the project agent row (the orchestrator) the ACP session runs.
	AgentID string
}

// Tokens is the registry of live per-session bearer tokens.
type Tokens struct {
	mu sync.RWMutex
	m  map[string]Binding
}

func NewTokens() *Tokens { return &Tokens{m: map[string]Binding{}} }

// Issue mints a random 256-bit token bound to b.
func (t *Tokens) Issue(b Binding) string {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		panic("mcp: no randomness: " + err.Error())
	}
	tok := hex.EncodeToString(raw[:])
	t.mu.Lock()
	t.m[tok] = b
	t.mu.Unlock()
	return tok
}

// Revoke invalidates a token; unknown tokens are ignored.
func (t *Tokens) Revoke(tok string) {
	t.mu.Lock()
	delete(t.m, tok)
	t.mu.Unlock()
}

// Lookup resolves a presented token. Every live token is compared in constant
// time (the scan does not stop at a match).
func (t *Tokens) Lookup(presented string) (Binding, bool) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	var found Binding
	ok := 0
	for tok, b := range t.m {
		if subtle.ConstantTimeCompare([]byte(tok), []byte(presented)) == 1 {
			found, ok = b, 1
		}
	}
	return found, ok == 1
}

// Live is the number of unrevoked tokens (for tests).
func (t *Tokens) Live() int {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return len(t.m)
}
