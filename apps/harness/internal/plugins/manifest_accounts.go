package plugins

import (
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strings"
)

// DirPlaceholder is replaced by an account's folder in the manifest's accounts.env.
const DirPlaceholder = "{dir}"

// manifestAccounts is an agent's `accounts` block: Env keeps one login of the
// CLI apart from another ({dir} is the account's folder); Unsupported says why
// it cannot; Note is shown beside the accounts.
type manifestAccounts struct {
	Env         map[string]string `json:"env"`
	Unsupported string            `json:"unsupported"`
	Note        string            `json:"note"`
}

// manifestLogin is one entry of auth.login: an interactive command that logs
// the CLI in (args[0] is the program).
type manifestLogin struct {
	ID    string   `json:"id"`
	Label string   `json:"label"`
	Args  []string `json:"args"`
}

func (m manifestAccounts) validate() error {
	if strings.TrimSpace(m.Unsupported) != "" {
		if len(m.Env) > 0 {
			return fmt.Errorf("accounts: env and unsupported exclude each other")
		}
		return nil
	}
	if len(m.Env) == 0 {
		return fmt.Errorf("accounts: env must name at least one variable, or say unsupported")
	}
	hasDir := false
	for _, k := range sortedKeys(m.Env) {
		v := m.Env[k]
		switch {
		case !envKeyPat.MatchString(k):
			return fmt.Errorf("accounts.env name %q is not a valid variable name", k)
		case strings.Contains(v, "${"):
			return fmt.Errorf("accounts.env %s: ${NAME} references are not allowed", k)
		}
		hasDir = hasDir || strings.Contains(v, DirPlaceholder)
	}
	if !hasDir {
		return fmt.Errorf("accounts.env: one value must contain %s", DirPlaceholder)
	}
	return nil
}

func validateLogins(logins []manifestLogin) error {
	seen := map[string]bool{}
	for i, l := range logins {
		switch {
		case strings.TrimSpace(l.ID) == "":
			return fmt.Errorf("auth.login[%d]: id is required", i)
		case seen[l.ID]:
			return fmt.Errorf("auth.login: duplicate id %q", l.ID)
		case strings.TrimSpace(l.Label) == "":
			return fmt.Errorf("auth.login %q: label is required", l.ID)
		case len(l.Args) == 0 || strings.TrimSpace(l.Args[0]) == "":
			return fmt.Errorf("auth.login %q: args[0] must be a command", l.ID)
		}
		seen[l.ID] = true
	}
	return nil
}

func validateLimitPatterns(patterns []string) error {
	for _, p := range patterns {
		if strings.TrimSpace(p) == "" {
			return fmt.Errorf("limitPatterns: a pattern must not be empty")
		}
		if _, err := regexp.Compile(p); err != nil {
			return fmt.Errorf("limitPatterns: %w", err)
		}
	}
	return nil
}

// validateAccountFields checks the multi-account additions of an agent entry.
func (a manifestAgent) validateAccountFields() error {
	if a.Accounts != nil {
		if err := a.Accounts.validate(); err != nil {
			return err
		}
	}
	if a.Auth != nil {
		if err := validateLogins(a.Auth.Login); err != nil {
			return err
		}
	}
	return validateLimitPatterns(a.LimitPatterns)
}

// populateAccounts fills the account fields of ag from its (validated) manifest entry.
func populateAccounts(ag *Agent, a manifestAgent, dir string) {
	ag.BaseID = ag.ID
	for _, p := range a.LimitPatterns {
		ag.LimitPatterns = append(ag.LimitPatterns, regexp.MustCompile(p)) // validated with the manifest
	}
	sup := AccountsSupport{Reason: NoAccountsReason}
	switch {
	case a.Accounts == nil:
	case strings.TrimSpace(a.Accounts.Unsupported) != "":
		sup.Reason = strings.TrimSpace(a.Accounts.Unsupported)
	case ag.Unsupported != "":
		sup.Reason = ag.Unsupported
	default:
		sup = AccountsSupport{Supported: true, Note: strings.TrimSpace(a.Accounts.Note)}
		ag.accountEnv = maps.Clone(a.Accounts.Env)
	}
	if a.Accounts != nil && sup.Note == "" {
		sup.Note = strings.TrimSpace(a.Accounts.Note)
	}
	ag.Accounts = &sup
	if a.Auth == nil || ag.Unsupported != "" {
		return
	}
	for _, l := range a.Auth.Login {
		path, _ := resolveCommandIn(l.Args[0], dir, a.SearchPaths)
		ag.Logins = append(ag.Logins, LoginMethod{ID: l.ID, Label: strings.TrimSpace(l.Label), Args: slices.Clone(l.Args), command: path})
	}
}
