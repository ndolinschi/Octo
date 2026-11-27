package plugins

import (
	"regexp"
	"strings"
)

var (
	backtickSpan   = regexp.MustCompile("`([^`]+)`")
	installCommand = regexp.MustCompile(`npm install -g \S+`)
)

// LoginCmd is the terminal command that logs the agent's CLI in: the
// manifest's auth.command, else the first command in backticks of its login
// hint that says "login", else its first auth.login command. "" when none
// names one. An account's LoginCommand carries its folder variables.
func (a Agent) LoginCmd() string {
	if a.LoginCommand != "" {
		return a.LoginCommand
	}
	for _, m := range backtickSpan.FindAllStringSubmatch(a.Hint, -1) {
		if strings.Contains(m[1], "login") {
			return m[1]
		}
	}
	if len(a.Logins) > 0 {
		return shellJoin(a.Logins[0].Args)
	}
	return ""
}

// InstallCmd is a copyable install command found in the agent's install text:
// an `npm install -g` line, else the first command in backticks that names an
// installer ("install" in it). "" when there is none. Running it again also
// updates the CLI, so it is the update line of a CLI that is too old.
func (a Agent) InstallCmd() string {
	if c := installCommand.FindString(a.InstallHint); c != "" {
		return c
	}
	for _, m := range backtickSpan.FindAllStringSubmatch(a.InstallHint, -1) {
		if strings.Contains(m[1], "install") {
			return m[1]
		}
	}
	return ""
}

// TooOldDetails is the technical text of a CLI that is too old: the version
// check's reason and the install line.
func (a Agent) TooOldDetails() string {
	return strings.TrimSpace(a.Version.Reason + ". " + a.InstallHint)
}
