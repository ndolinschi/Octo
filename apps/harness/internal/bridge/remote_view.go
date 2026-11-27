package bridge

import (
	"net/http"
	"slices"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/providers"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// localRequest reports whether r comes from this machine's own UI: a loopback
// peer, a loopback Host and no foreign Origin (the checks of loopbackGuard,
// without the 403). A request that a paired device sends through the tunnel
// arrives from loopback too, but with the tunnel's Host and Origin, so it is
// not local. A bridge on a non-loopback address is not special here: a client
// of another machine has a non-loopback peer.
func (s *Server) localRequest(r *http.Request) bool {
	if !loopbackPeer(r.RemoteAddr) || !loopbackHost(r.Host) {
		return false
	}
	o := r.Header.Get("Origin")
	return o == "" || s.originAllowed(o)
}

// What stands in for an account's folder and login command in text a paired device sees.
const (
	folderWord  = "its own folder on the computer Octo runs on"
	commandWord = "its login command (shown in Settings on the computer Octo runs on)"
)

// forDevice is resp as a paired device may see it: no account folder, no
// "owned" flag and no login command (it carries the folder), and the folder
// left out of the login text. The device manages no account and runs no
// login; the rest is unchanged.
func forDevice(resp providers.Response) providers.Response {
	out := resp
	out.Providers = slices.Clone(resp.Providers)
	for i := range out.Providers {
		p := &out.Providers[i]
		cmd, dir := p.LoginCommand, p.AccountDir
		p.LoginCommand, p.AccountDir, p.AccountDefault, p.AccountOwned = "", "", "", false
		p.LoginHint, p.Reason = scrub(p.LoginHint, cmd, dir), scrub(p.Reason, cmd, dir)
		p.Problem = problemForDevice(p.Problem, cmd, dir)
		p.ModelsProblem = problemForDevice(p.ModelsProblem, cmd, dir)
	}
	return out
}

// pluginsForDevice is list as a paired device may see it (see forDevice).
func pluginsForDevice(list []plugins.Plugin) []plugins.Plugin {
	out := slices.Clone(list)
	for i := range out {
		out[i].Agents = slices.Clone(out[i].Agents)
		for j := range out[i].Agents {
			a := &out[i].Agents[j]
			cmd, dir := a.LoginCommand, a.AccountDir
			a.LoginCommand, a.AccountDir, a.AccountDefault, a.AccountOwned = "", "", "", false
			a.Hint = scrub(a.Hint, cmd, dir)
		}
	}
	return out
}

// scrub is s without an account's login command cmd and folder dir.
func scrub(s, cmd, dir string) string {
	if dir == "" {
		return s
	}
	if cmd != "" {
		s = strings.ReplaceAll(s, "`"+cmd+"`", commandWord)
		s = strings.ReplaceAll(s, cmd, commandWord)
	}
	return strings.ReplaceAll(s, dir, folderWord)
}

// problemForDevice drops the command of a problem (a login line of an
// account carries its folder) and the folder from its text.
func problemForDevice(e *usererr.Error, cmd, dir string) *usererr.Error {
	if e == nil {
		return nil
	}
	c := *e
	c.Command = ""
	c.Message, c.Hint, c.Details = scrub(c.Message, cmd, dir), scrub(c.Hint, cmd, dir), scrub(c.Details, cmd, dir)
	return &c
}
