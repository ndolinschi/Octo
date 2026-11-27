package plugins

import (
	"fmt"
	"maps"
	"path/filepath"
	"slices"
	"strings"
)

// accountView is the derived-agent overlay SetAccounts swaps in whole; its maps
// are never changed after the swap, so a reader may keep using one it took.
type accountView struct {
	derived map[string]Agent    // derived id -> agent (no probe state)
	order   map[string][]string // base id -> its derived ids, in spec order
	names   map[string]string   // base id -> display name of its default account
}

func (r *Registry) view() accountView {
	r.accMu.RLock()
	defer r.accMu.RUnlock()
	return r.acc
}

// SetAccounts replaces the accounts expanded into derived agents: each spec
// becomes agent DerivedID(spec.Agent, spec.ID) with the base agent's launch,
// the manifest's accounts.env ({dir} = spec.Dir) laid over its environment, and
// the label "<base label> · <name>". defaultNames are the display names of the
// base agents' own logins. A spec whose base agent is unknown or cannot keep
// accounts apart, or that is malformed, is skipped with an error. Probe,
// login and limit state of ids that are gone is dropped.
func (r *Registry) SetAccounts(specs []AccountSpec, defaultNames map[string]string) []error {
	if r == nil {
		return nil
	}
	var errs []error
	v := accountView{derived: map[string]Agent{}, order: map[string][]string{}, names: map[string]string{}}
	for base, n := range defaultNames {
		if n = strings.TrimSpace(n); n != "" {
			v.names[base] = n
		}
	}
	for _, s := range specs {
		a, err := r.derive(s)
		if err == nil {
			if _, dup := v.derived[a.ID]; dup {
				err = fmt.Errorf("account %s: duplicate", a.ID)
			}
		}
		if err != nil {
			errs = append(errs, err)
			continue
		}
		v.derived[a.ID] = a
		v.order[s.Agent] = append(v.order[s.Agent], a.ID)
	}
	r.accMu.Lock()
	old := r.acc
	r.acc = v
	r.accMu.Unlock()
	for id := range old.derived {
		if _, ok := v.derived[id]; !ok {
			r.forget(id)
		}
	}
	return errs
}

func (r *Registry) derive(s AccountSpec) (Agent, error) {
	id := DerivedID(s.Agent, s.ID)
	base, ok := r.agents[s.Agent]
	name := strings.TrimSpace(s.Name)
	switch {
	case !ok:
		return Agent{}, fmt.Errorf("account %s: no agent %q is loaded", id, s.Agent)
	case base.accountEnv == nil:
		return Agent{}, fmt.Errorf("account %s: the agent cannot keep accounts apart", id)
	case !ValidSlug(s.ID) || s.ID == ReservedSlug:
		return Agent{}, fmt.Errorf("account %s: %q is not a valid account id", id, s.ID)
	case name == "":
		return Agent{}, fmt.Errorf("account %s: the name is empty", id)
	case !filepath.IsAbs(s.Dir) || strings.Contains(s.Dir, "${"):
		return Agent{}, fmt.Errorf("account %s: the folder must be an absolute path", id)
	}
	a := base
	a.ID, a.BaseID = id, base.ID
	overlay := make(map[string]string, len(base.accountEnv))
	for k, val := range base.accountEnv {
		overlay[k] = strings.ReplaceAll(val, DirPlaceholder, s.Dir)
	}
	env := maps.Clone(base.Launch.Env)
	if env == nil {
		env = map[string]string{}
	}
	maps.Copy(env, overlay)
	a.Launch.Env = env
	a.Label = base.Label + " · " + name
	a.Account = &AccountInfo{ID: s.ID, Name: name, Dir: s.Dir, Owned: s.Owned}
	a.Accounts, a.accountEnv = nil, nil
	a.Limit = nil
	a.LoginCommand = ""
	if cmd := base.LoginCmd(); cmd != "" {
		a.LoginCommand = envPrefix(overlay) + " " + cmd
	}
	// The base's login text would log in the default account; an account's
	// own command (LoginCmd) already carries its folder, which a hint must not.
	a.Hint = accountHint
	if a.LoginCommand != "" {
		a.Hint = accountHintWithCommand
	}
	return a, nil
}

// Login text of a derived account, in place of the base agent's own.
const (
	accountHint            = "This account keeps its login apart from the default one: the default account's login steps do not apply to it."
	accountHintWithCommand = "Log in to this account with its own login command, not the default account's."
)

// envPrefix is env as shell assignments (NAME='value' ...), sorted by name.
func envPrefix(env map[string]string) string {
	parts := make([]string, 0, len(env))
	for _, k := range sortedKeys(env) {
		parts = append(parts, k+"="+shellQuote(env[k]))
	}
	return strings.Join(parts, " ")
}

func shellJoin(args []string) string {
	out := make([]string, len(args))
	for i, a := range args {
		out[i] = a
		if a == "" || strings.ContainsFunc(a, func(r rune) bool { return !isShellSafe(r) }) {
			out[i] = shellQuote(a)
		}
	}
	return strings.Join(out, " ")
}

func isShellSafe(r rune) bool {
	return r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("-_./=:@%+,", r)
}

// shellQuote single-quotes s for a POSIX shell.
func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// Support says whether the manifest agent base can keep more than one login;
// false for an unknown id or a derived one.
func (r *Registry) Support(base string) (AccountsSupport, bool) {
	if r == nil {
		return AccountsSupport{}, false
	}
	a, ok := r.agents[base]
	if !ok || a.Accounts == nil {
		return AccountsSupport{}, false
	}
	return *a.Accounts, true
}

// decorate gives a manifest agent its default-account fields: the account (when
// it can keep several) and, while it has derived accounts, the label
// "<label> · <default name>".
func (v accountView) decorate(a Agent) Agent {
	if a.Accounts == nil || !a.Accounts.Supported {
		return a
	}
	name := v.names[a.ID]
	if name == "" {
		name = DefaultAccountName
	}
	a.Account = &AccountInfo{Name: name, Default: true}
	if len(v.order[a.ID]) > 0 {
		a.Label += " · " + name
	}
	return a
}

// expand lists agents (manifest agents in load order) with each one's derived
// accounts right after it.
func (v accountView) expand(in []Agent) []Agent {
	out := make([]Agent, 0, len(in)+len(v.derived))
	for _, a := range in {
		out = append(out, v.decorate(a))
		for _, id := range v.order[a.ID] {
			out = append(out, v.derived[id])
		}
	}
	return out
}

// raw is the agent with id without probe state: a manifest agent decorated, or a derived account.
func (r *Registry) raw(id string) (Agent, bool) {
	v := r.view()
	if a, ok := r.agents[id]; ok {
		return v.decorate(a), true
	}
	a, ok := v.derived[id]
	return a, ok
}

// has reports whether id is a manifest agent or a current account.
func (r *Registry) has(id string) bool {
	_, ok := r.raw(id)
	return ok
}

// forget drops what the registry remembers about an agent id that is gone.
func (r *Registry) forget(id string) {
	r.seenMu.Lock()
	delete(r.seenOut, id)
	delete(r.limits, id)
	r.seenMu.Unlock()
	if r.probes != nil {
		r.probes.mu.Lock()
		delete(r.probes.state, id)
		r.probes.mu.Unlock()
	}
	if r.versions != nil {
		r.versions.mu.Lock()
		delete(r.versions.state, id)
		r.versions.mu.Unlock()
	}
}

// LoginSpec is how to run one of the agent's interactive login commands
// (method "" is the first): the program (resolved like the agent's own), its
// arguments and the agent's resolved environment, account variables included.
// ok is false when the agent has no such login command.
func (a Agent) LoginSpec(method string) (command string, args []string, env map[string]string, ok bool) {
	if a.Unsupported != "" || len(a.Logins) == 0 {
		return "", nil, nil, false
	}
	i := 0
	if method != "" {
		if i = slices.IndexFunc(a.Logins, func(m LoginMethod) bool { return m.ID == method }); i < 0 {
			return "", nil, nil, false
		}
	}
	m := a.Logins[i]
	command = m.command
	if command == "" {
		command = m.Args[0]
	}
	return command, slices.Clone(m.Args[1:]), a.ResolvedEnv(), true
}
