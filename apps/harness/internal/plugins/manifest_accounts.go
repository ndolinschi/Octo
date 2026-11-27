package plugins

import (
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strings"
)

// NoAccountsReason is why an agent whose manifest has no accounts block keeps one login only.
const NoAccountsReason = "Octo knows no documented way to keep a second login of this CLI apart."

// manifestAccounts is an agent's `accounts` block. Env names the variable that
// moves the CLI's config and login folder; Default is the folder used when it
// is not set (shown, not used). The optional fields: ExtraEnv are more
// variables set on every extra account (never on the agent's own entry), Note
// is shown beside the accounts, and Unsupported (without Env) says why the
// agent keeps one login only.
type manifestAccounts struct {
	Env         string            `json:"env"`
	Default     string            `json:"default"`
	ExtraEnv    map[string]string `json:"extraEnv"`
	Note        string            `json:"note"`
	Unsupported string            `json:"unsupported"`
}

// manifestLogin is one entry of auth.login: an interactive command that logs
// the CLI in (args[0] is the program).
type manifestLogin struct {
	ID    string   `json:"id"`
	Label string   `json:"label"`
	Args  []string `json:"args"`
}

func (m manifestAccounts) unsupported() string { return strings.TrimSpace(m.Unsupported) }

func (m manifestAccounts) validate() error {
	if m.unsupported() != "" {
		if m.Env != "" || len(m.ExtraEnv) > 0 {
			return fmt.Errorf("accounts: env and unsupported exclude each other")
		}
		return nil
	}
	if !envKeyPat.MatchString(m.Env) {
		return fmt.Errorf("accounts.env %q is not a valid variable name", m.Env)
	}
	for _, k := range sortedKeys(m.ExtraEnv) {
		switch v := m.ExtraEnv[k]; {
		case !envKeyPat.MatchString(k):
			return fmt.Errorf("accounts.extraEnv name %q is not a valid variable name", k)
		case k == m.Env:
			return fmt.Errorf("accounts.extraEnv must not set %s, the account folder's variable", k)
		case strings.Contains(v, "$"):
			return fmt.Errorf("accounts.extraEnv %s: $ references are not allowed", k)
		}
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
	for _, p := range a.LimitPatterns {
		ag.LimitPatterns = append(ag.LimitPatterns, regexp.MustCompile(p)) // validated with the manifest
	}
	switch {
	case a.Accounts == nil:
		ag.AccountUnsupported = NoAccountsReason
	case a.Accounts.unsupported() != "":
		ag.AccountUnsupported = a.Accounts.unsupported()
	case ag.Unsupported != "":
		ag.AccountUnsupported = ag.Unsupported
	default:
		ag.AccountEnv, ag.AccountDefault = a.Accounts.Env, strings.TrimSpace(a.Accounts.Default)
		ag.accountExtraEnv = maps.Clone(a.Accounts.ExtraEnv)
	}
	if a.Accounts != nil {
		ag.AccountNote = strings.TrimSpace(a.Accounts.Note)
	}
	if a.Auth == nil || ag.Unsupported != "" {
		return
	}
	for _, l := range a.Auth.Login {
		path, _ := resolveCommandIn(l.Args[0], dir, a.SearchPaths)
		ag.Logins = append(ag.Logins, LoginMethod{ID: l.ID, Label: strings.TrimSpace(l.Label), Args: slices.Clone(l.Args), command: path})
	}
}
