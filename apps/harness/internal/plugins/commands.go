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
// hint that says "login". "" when neither names one.
func (a Agent) LoginCmd() string {
	if a.LoginCommand != "" {
		return a.LoginCommand
	}
	for _, m := range backtickSpan.FindAllStringSubmatch(a.Hint, -1) {
		if strings.Contains(m[1], "login") {
			return m[1]
		}
	}
	return ""
}

// InstallCmd is a copyable install command found in the agent's install text
// ("" when there is none).
func (a Agent) InstallCmd() string { return installCommand.FindString(a.InstallHint) }
