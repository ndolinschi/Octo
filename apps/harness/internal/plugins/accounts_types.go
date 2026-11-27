package plugins

import (
	"slices"
	"time"
)

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

// LoginSpec is how to run one of the agent's interactive login commands
// (method "" is the first): the program (resolved like the agent's own), its
// arguments and the agent's resolved environment, an account's folder
// variable included. ok is false when the agent has no such login command.
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
