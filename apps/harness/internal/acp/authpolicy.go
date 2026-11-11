package acp

import (
	"encoding/json"
	"strings"
)

// AuthPref is one entry of a manifest's auth.methods: a method id and, for an
// API-key style method, the variable that must be set in the child's
// environment for the method to be tried.
type AuthPref struct {
	ID          string
	RequiresEnv string
}

// AuthPolicy narrows which advertised auth methods the client may try. The
// zero value keeps the default: every method that needs no interaction, in
// the order the agent offers them.
type AuthPolicy struct {
	// Methods, when set, is the only set of methods tried, in this order.
	Methods []AuthPref
	// Skip lists method ids that are never tried.
	Skip []string
}

var (
	interactiveIDs   = []string{"device", "pairing", "terminal", "browser", "login"}
	interactiveWords = []string{"browser", "terminal", "interactive", "pairing", "device code"}
)

// looksInteractive guesses from the id and description that a method needs a
// person (the agent's type field is checked separately by Unattended).
func (m AuthMethod) looksInteractive() bool {
	id := strings.ToLower(m.ID)
	for _, k := range interactiveIDs {
		if strings.Contains(id, k) {
			return true
		}
	}
	desc := strings.ToLower(m.Description)
	for _, k := range interactiveWords {
		if strings.Contains(desc, k) {
			return true
		}
	}
	return false
}

// terminalOnly reports a method that can only be completed in a terminal.
func (m AuthMethod) terminalOnly() bool {
	if m.Type == "terminal" {
		return true
	}
	var meta map[string]json.RawMessage
	if json.Unmarshal(m.Meta, &meta) == nil {
		_, legacy := meta["terminal-auth"]
		return legacy
	}
	return false
}

// candidates returns the advertised methods to try in order and, for the
// error message, the explicit preferences that could not be used and why.
func (p AuthPolicy) candidates(advertised []AuthMethod, lookupEnv func(string) bool) (try []AuthMethod, unusable []string) {
	skipped := func(id string) bool {
		for _, s := range p.Skip {
			if s == id {
				return true
			}
		}
		return false
	}
	if len(p.Methods) == 0 {
		for _, m := range advertised {
			if m.Unattended() && !skipped(m.ID) && !m.looksInteractive() {
				try = append(try, m)
			}
		}
		return try, nil
	}
	for _, pref := range p.Methods {
		var found *AuthMethod
		for i := range advertised {
			if advertised[i].ID == pref.ID {
				found = &advertised[i]
				break
			}
		}
		switch {
		case found == nil:
			unusable = append(unusable, pref.ID+" (not offered by the agent)")
		case skipped(pref.ID):
			unusable = append(unusable, pref.ID+" (skipped)")
		case found.terminalOnly():
			unusable = append(unusable, pref.ID+" (terminal login)")
		case pref.RequiresEnv != "" && !lookupEnv(pref.RequiresEnv):
			unusable = append(unusable, pref.ID+" (needs "+pref.RequiresEnv+" set)")
		default:
			try = append(try, *found)
		}
	}
	return try, unusable
}
