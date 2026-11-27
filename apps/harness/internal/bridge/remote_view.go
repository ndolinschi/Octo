package bridge

import (
	"net/http"
	"slices"

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

// forDevice is resp as a paired device may see it: no account folder, no
// "owned" flag and no login command (it can contain the folder). The device
// manages no account and runs no login; the rest is unchanged.
func forDevice(resp providers.Response) providers.Response {
	out := resp
	out.Providers = slices.Clone(resp.Providers)
	for i := range out.Providers {
		p := &out.Providers[i]
		p.LoginCommand = ""
		p.Account = withoutFolder(p.Account)
		p.Problem = withoutCommand(p.Problem)
		p.ModelsProblem = withoutCommand(p.ModelsProblem)
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
			a.LoginCommand = ""
			a.Account = withoutFolder(a.Account)
		}
	}
	return out
}

func withoutFolder(a *plugins.AccountInfo) *plugins.AccountInfo {
	if a == nil {
		return nil
	}
	c := *a
	c.Dir, c.Owned = "", false
	return &c
}

// withoutCommand drops the command of a problem: a login line of an account carries its folder.
func withoutCommand(e *usererr.Error) *usererr.Error {
	if e == nil || e.Command == "" {
		return e
	}
	c := *e
	c.Command = ""
	return &c
}
