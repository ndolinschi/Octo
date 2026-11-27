package plugins

import (
	"regexp"
	"strings"
	"time"
)

// AccountSep joins a base agent id and an account slug into a derived agent id
// ("claude-code@work"). Manifest ids cannot contain it, so the two never clash.
const AccountSep = "@"

// DefaultAccountName is the display name of a base agent's own login while no
// other name is stored for it.
const DefaultAccountName = "Default"

// ReservedSlug is the slug no account may take: the bare base id is the default account.
const ReservedSlug = "default"

// NoAccountsReason is why an agent whose manifest has no accounts block keeps one login only.
const NoAccountsReason = "Octo knows no documented way to keep a second login of this CLI apart."

var slugPattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$`)

// DerivedID is the agent id of account slug of base.
func DerivedID(base, slug string) string { return base + AccountSep + slug }

// SplitID splits a derived id into its base agent id and account slug; a
// manifest id comes back whole with slug "".
func SplitID(id string) (base, slug string) {
	base, slug, _ = strings.Cut(id, AccountSep)
	return base, slug
}

// ValidSlug reports whether s may be an account slug: lower-case letters,
// digits and inner dashes, 1 to 32 characters.
func ValidSlug(s string) bool { return slugPattern.MatchString(s) }

// AccountSpec is one stored account of a base agent, as SetAccounts expands it.
type AccountSpec struct {
	Agent, ID, Name, Dir string
	Owned                bool
}

// AccountInfo is the account an agent entry stands for. ID "" is the base
// agent's own (default) login.
type AccountInfo struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Default bool   `json:"default"`
	Dir     string `json:"dir,omitempty"`
	Owned   bool   `json:"owned,omitempty"`
}

// AccountsSupport says whether a base agent can keep more than one login.
type AccountsSupport struct {
	Supported bool   `json:"supported"`
	Reason    string `json:"reason,omitempty"`
	Note      string `json:"note,omitempty"`
}

// LoginMethod is one of the manifest's auth.login entries: a command that logs
// the CLI in interactively. Args is the manifest's command line (args[0] the
// program); command is args[0] resolved like the agent's own program.
type LoginMethod struct {
	ID    string   `json:"id"`
	Label string   `json:"label"`
	Args  []string `json:"-"`

	command string
}

// LimitState is a usage or rate limit a real session of the agent ran into.
type LimitState struct {
	ReachedAt time.Time  `json:"reached_at"`
	ResetsAt  *time.Time `json:"resets_at,omitempty"`
}
