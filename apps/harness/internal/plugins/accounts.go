package plugins

import (
	"fmt"
	"maps"
	"runtime"
	"strings"
)

// AccountSep joins an agent id and one of its account ids into the id of the
// account's own agent: "claude-code@work", used as `acp:claude-code@work/opus`.
// Manifest ids never contain it (idPattern), so the split is unambiguous.
const AccountSep = "@"

// Account is one extra login of an agent whose manifest has `accounts`: the
// agent started with its AccountEnv set to ConfigDir, the folder where the CLI
// keeps that login. Octo never reads, stores or logs what is in the folder;
// the user logs in with the CLI (the account's login command). Owned: Octo
// created the folder when the account was added (absent in files written
// before it existed, which reads as false: such a folder is never deleted).
type Account struct {
	ID        string `json:"id"`
	Agent     string `json:"agent"`
	Label     string `json:"label"`
	ConfigDir string `json:"config_dir"`
	Owned     bool   `json:"owned,omitempty"`
}

// AccountAgentID is the id of the agent that runs account of agent.
func AccountAgentID(agent, account string) string { return agent + AccountSep + account }

// SplitAccountID splits "agent@account"; ok is false for a plain agent id.
func SplitAccountID(id string) (agent, account string, ok bool) {
	agent, account, ok = strings.Cut(id, AccountSep)
	if !ok || agent == "" || account == "" {
		return "", "", false
	}
	return agent, account, true
}

// Base is the manifest agent a entry runs: AccountOf for an account's own
// entry, else its own id.
func (a Agent) Base() string {
	if a.AccountOf != "" {
		return a.AccountOf
	}
	return a.ID
}

// ExpandAccountDir is dir with a leading "~/" replaced by the user's home.
func ExpandAccountDir(dir string) string { return expandHome(dir) }

// SetAccounts makes the registry list the accounts f returns (read on every
// call, so an account added through the API shows at once). An account whose
// agent is unknown or has no `accounts` in its manifest is left out.
func (r *Registry) SetAccounts(f func() []Account) {
	if r == nil {
		return
	}
	r.acctMu.Lock()
	r.accounts = f
	r.acctMu.Unlock()
}

// SetDefaultLabels makes the registry name each agent's own (default) login
// with the label f returns for its id: the entry reads "<label> · <name>" and
// carries AccountDefaultLabel. An agent without a label keeps its own.
func (r *Registry) SetDefaultLabels(f func() map[string]string) {
	if r == nil {
		return
	}
	r.acctMu.Lock()
	r.defaultLabels = f
	r.acctMu.Unlock()
}

func (r *Registry) accountList() []Account {
	r.acctMu.RLock()
	f := r.accounts
	r.acctMu.RUnlock()
	if f == nil {
		return nil
	}
	return f()
}

func (r *Registry) defaultLabelMap() map[string]string {
	r.acctMu.RLock()
	f := r.defaultLabels
	r.acctMu.RUnlock()
	if f == nil {
		return nil
	}
	return f()
}

// withDefaultLabel names a manifest agent's own login when the user gave it a name.
func (r *Registry) withDefaultLabel(a Agent, labels map[string]string) Agent {
	if l := strings.TrimSpace(labels[a.ID]); l != "" && a.AccountEnv != "" {
		a.AccountDefaultLabel = l
		a.Label += " · " + l
	}
	return a
}

// withAccounts is in with each agent followed by the agents of its accounts.
func (r *Registry) withAccounts(in []Agent) []Agent {
	accts, labels := r.accountList(), r.defaultLabelMap()
	if len(accts) == 0 && len(labels) == 0 {
		return in
	}
	out := make([]Agent, 0, len(in))
	for _, a := range in {
		out = append(out, r.withDefaultLabel(a, labels))
		if a.AccountEnv == "" {
			continue
		}
		for _, acct := range accts {
			if acct.Agent == a.ID {
				out = append(out, deriveAccount(a, acct))
			}
		}
	}
	return out
}

// accountAgent looks up the agent of an account id ("claude-code@work").
func (r *Registry) accountAgent(id string) (Agent, bool) {
	base, acctID, ok := SplitAccountID(id)
	if !ok {
		return Agent{}, false
	}
	b, ok := r.agents[base]
	if !ok || b.AccountEnv == "" {
		return Agent{}, false
	}
	for _, acct := range r.accountList() {
		if acct.Agent == base && acct.ID == acctID {
			return deriveAccount(b, acct), true
		}
	}
	return Agent{}, false
}

// has reports whether id is a manifest agent or a current account.
func (r *Registry) has(id string) bool {
	if _, ok := r.agents[id]; ok {
		return true
	}
	_, ok := r.accountAgent(id)
	return ok
}

// Forget drops what the registry remembers about an agent id that is gone (an
// account just removed): its login probe, "seen logged out" and limit state,
// so an account added again later under the same id starts clean.
func (r *Registry) Forget(id string) {
	if r == nil {
		return
	}
	r.seenMu.Lock()
	delete(r.seenOut, id)
	delete(r.limits, id)
	r.seenMu.Unlock()
	if r.probes != nil {
		r.probes.mu.Lock()
		delete(r.probes.state, id)
		r.probes.mu.Unlock()
	}
}

// deriveAccount is base started for acct: the same program, models and probe,
// its own id and label, and base.AccountEnv set to the account's folder in its
// environment (so the login probe, model listing and sessions all use that
// login). The login command and hint say how to log that folder in.
func deriveAccount(base Agent, acct Account) Agent {
	a := base
	dir := ExpandAccountDir(acct.ConfigDir)
	a.ID = AccountAgentID(base.ID, acct.ID)
	a.Label = base.Label + " · " + acct.Label
	env := maps.Clone(base.Env)
	if env == nil {
		env = map[string]string{}
	}
	maps.Copy(env, base.accountExtraEnv)
	env[base.AccountEnv] = dir
	a.Env = env
	a.AccountOf, a.AccountID, a.AccountLabel, a.AccountDir, a.AccountOwned = base.ID, acct.ID, acct.Label, dir, acct.Owned
	a.AccountEnv, a.AccountDefault, a.AccountNote, a.AccountUnsupported, a.AccountDefaultLabel = "", "", "", "", ""
	a.accountExtraEnv = nil
	if login := base.LoginCmd(); login != "" {
		a.LoginCommand = accountLoginCommand(base, dir, login)
		a.Hint = fmt.Sprintf("Log this account in once: run `%s` in a terminal. Its login stays in %s.", a.LoginCommand, dir)
	} else {
		a.LoginCommand = ""
		a.Hint = fmt.Sprintf("Log this account in once with %s set to %s, then check again.", base.AccountEnv, dir)
	}
	return a
}

// accountLoginCommand is AccountLoginCommand with the manifest's
// accounts.extraEnv set too.
func accountLoginCommand(base Agent, dir, login string) string {
	if len(base.accountExtraEnv) == 0 {
		return AccountLoginCommand(base.AccountEnv, dir, login)
	}
	var b strings.Builder
	for _, k := range sortedKeys(base.accountExtraEnv) {
		if runtime.GOOS == "windows" {
			fmt.Fprintf(&b, "$env:%s=%s; ", k, psQuote(base.accountExtraEnv[k]))
		} else {
			fmt.Fprintf(&b, "%s=%s ", k, shQuote(base.accountExtraEnv[k]))
		}
	}
	if runtime.GOOS == "windows" {
		return b.String() + AccountLoginCommand(base.AccountEnv, dir, login)
	}
	return strings.TrimSuffix(b.String(), " ") + " " + AccountLoginCommand(base.AccountEnv, dir, login)
}

// AccountLoginCommand is login run with env set to dir, as a person types it
// in a terminal (POSIX shells; PowerShell on Windows).
func AccountLoginCommand(env, dir, login string) string {
	if runtime.GOOS == "windows" {
		return fmt.Sprintf("$env:%s=%s; %s", env, psQuote(dir), login)
	}
	return env + "=" + shQuote(dir) + " " + login
}

// shQuote quotes s for a POSIX shell when it needs it.
func shQuote(s string) string {
	if s != "" && strings.IndexFunc(s, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("/._-+:,@%", r))
	}) < 0 {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func psQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

// shellJoin is args as one POSIX command line, quoting what needs it.
func shellJoin(args []string) string {
	out := make([]string, len(args))
	for i, a := range args {
		out[i] = shQuote(a)
	}
	return strings.Join(out, " ")
}
