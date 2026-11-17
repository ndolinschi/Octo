package remoteaccess

import "strings"

// Class is what a request through the tunnel listener needs from a device.
type Class string

const (
	// ClassDeny is never allowed for a device (local only).
	ClassDeny Class = "deny"
	// ClassRead is always allowed for an active device.
	ClassRead Class = "read"
	// ClassSend, ClassAnswer and ClassStop each need the permission of that name (HARNESS_REMOTE_ALLOW) and a device
	// that is not read-only.
	ClassSend   Class = "send"
	ClassAnswer Class = "answer"
	ClassStop   Class = "stop"
)

type rule struct {
	method  string // "*" = any
	pattern string // segments; "*" one segment, "**" one or more
	class   Class
}

// rules is the allow-list of the tunnel listener, first match wins. Anything that matches no rule is denied, so a
// route added to the bridge later is closed through the tunnel until it is classified here
// (TestEveryBridgeRouteIsClassified reads the bridge's route table and fails for an unclassified one).
var rules = []rule{
	// Local only, whatever the method.
	{"*", "/v1/settings", ClassDeny},
	{"*", "/v1/diagnostics", ClassDeny},
	{"*", "/v1/fs/**", ClassDeny},
	{"*", "/v1/remote", ClassDeny},
	{"*", "/v1/remote/**", ClassDeny},
	{"*", "/v1/providers/**", ClassDeny},
	{"*", "/mcp", ClassDeny},
	{"*", "/mcp/**", ClassDeny},
	{"POST", "/v1/projects", ClassDeny},
	{"PATCH", "/v1/projects/*", ClassDeny},
	{"DELETE", "/v1/projects/*", ClassDeny},
	{"*", "/v1/projects/*/secrets", ClassDeny},
	{"*", "/v1/projects/*/secrets/**", ClassDeny},
	{"*", "/v1/projects/*/lsp", ClassDeny},
	{"*", "/v1/projects/*/lsp/**", ClassDeny},
	{"*", "/v1/projects/*/browser", ClassDeny},
	{"*", "/v1/projects/*/browser/**", ClassDeny},
	{"*", "/v1/projects/*/commands/**", ClassDeny},
	{"POST", "/v1/projects/*/runs", ClassDeny},
	{"POST", "/v1/projects/*/runs/**", ClassDeny},
	{"*", "/v1/projects/*/processes", ClassDeny},
	{"*", "/v1/projects/*/processes/**", ClassDeny},
	{"POST", "/v1/projects/*/complete", ClassDeny},
	{"PUT", "/v1/projects/*/files/content", ClassDeny},
	{"POST", "/v1/projects/*/changes/*/revert", ClassDeny},
	{"POST", "/v1/projects/*/rewind", ClassDeny},
	{"POST", "/v1/projects/*/compact", ClassDeny},
	{"POST", "/v1/projects/*/clear", ClassDeny},
	{"POST", "/v1/projects/*/sessions/*/rewind", ClassDeny},
	{"POST", "/v1/projects/*/sessions/*/compact", ClassDeny},
	{"POST", "/v1/projects/*/sessions/*/clear", ClassDeny},
	{"*", "/v1/projects/*/facts", ClassDeny},
	{"*", "/v1/projects/*/facts/**", ClassDeny},
	{"PUT", "/v1/projects/*/memory/**", ClassDeny},
	{"DELETE", "/v1/projects/*/memory/**", ClassDeny},
	{"POST", "/v1/projects/*/notes", ClassDeny},
	{"PATCH", "/v1/projects/*/notes/*", ClassDeny},
	{"DELETE", "/v1/projects/*/notes/*", ClassDeny},
	{"DELETE", "/v1/projects/*/approval-rules/*", ClassDeny},
	{"PATCH", "/v1/projects/*/sessions/*", ClassDeny},
	{"DELETE", "/v1/projects/*/sessions/*", ClassDeny},
	{"POST", "/v1/projects/*/reviews", ClassDeny},
	{"POST", "/v1/projects/*/reviews/**", ClassDeny},
	{"PATCH", "/v1/projects/*/reviews/**", ClassDeny},
	{"DELETE", "/v1/projects/*/reviews/**", ClassDeny},
	{"DELETE", "/v1/projects/*/review-workspace", ClassDeny},
	{"DELETE", "/v1/projects/*/sessions", ClassDeny},
	{"POST", "/v1/projects/*/sessions/import", ClassDeny},
	{"POST", "/v1/projects/*/sessions/*/worktree", ClassDeny},
	{"DELETE", "/v1/sessions", ClassDeny},
	{"GET", "/v1/sessions/importable", ClassDeny},

	// Send: messages and what shapes them.
	{"POST", "/v1/projects/*/messages", ClassSend},
	{"POST", "/v1/projects/*/attachments", ClassSend},
	{"POST", "/v1/projects/*/side", ClassSend},
	{"POST", "/v1/projects/*/side/stop", ClassSend},
	{"DELETE", "/v1/projects/*/side", ClassSend},
	{"DELETE", "/v1/projects/*/queue", ClassSend},
	{"POST", "/v1/projects/*/queue/resume", ClassSend},
	{"PATCH", "/v1/projects/*/queue/*", ClassSend},
	{"DELETE", "/v1/projects/*/queue/*", ClassSend},
	{"POST", "/v1/projects/*/queue/*/send-now", ClassSend},
	{"DELETE", "/v1/projects/*/sessions/*/queue", ClassSend},
	{"POST", "/v1/projects/*/sessions/*/queue/resume", ClassSend},
	{"PATCH", "/v1/projects/*/sessions/*/queue/*", ClassSend},
	{"DELETE", "/v1/projects/*/sessions/*/queue/*", ClassSend},
	{"POST", "/v1/projects/*/sessions/*/queue/*/send-now", ClassSend},
	{"POST", "/v1/projects/*/sessions", ClassSend},
	{"POST", "/v1/projects/*/sessions/*/messages", ClassSend},
	{"POST", "/v1/projects/*/sessions/*/resume", ClassSend},
	{"POST", "/v1/projects/*/sessions/*/default", ClassSend},

	// Answer: approvals, forms, plans.
	{"POST", "/v1/projects/*/approvals/*", ClassAnswer},
	{"POST", "/v1/projects/*/inputs/*", ClassAnswer},
	{"POST", "/v1/projects/*/plans/*/approve", ClassAnswer},

	// Stop.
	{"POST", "/v1/projects/*/cancel", ClassStop},
	{"POST", "/v1/projects/*/sessions/*/stop", ClassStop},

	// Read.
	{"GET", "/v1/config", ClassRead},
	{"GET", "/v1/plugins", ClassRead},
	{"GET", "/v1/providers", ClassRead},
	{"GET", "/v1/usage", ClassRead},
	{"GET", "/v1/limits", ClassRead},
	{"GET", "/v1/sessions", ClassRead},
	{"GET", "/v1/search", ClassRead},
	{"GET", "/v1/projects", ClassRead},
	{"GET", "/v1/projects/*", ClassRead},
	{"GET", "/v1/projects/*/**", ClassRead},
}

// Classify says what a request needs. explicit is false when no rule matched (the request is then denied).
func Classify(method, path string) (c Class, explicit bool) {
	segs := split(path)
	for _, r := range rules {
		if r.method != "*" && r.method != method {
			continue
		}
		if match(split(r.pattern), segs) {
			return r.class, true
		}
	}
	return ClassDeny, false
}

func split(p string) []string {
	p = strings.Trim(p, "/")
	if p == "" {
		return nil
	}
	return strings.Split(p, "/")
}

func match(pat, segs []string) bool {
	for i, p := range pat {
		if p == "**" {
			return len(segs) > i
		}
		if i >= len(segs) || (p != "*" && p != segs[i]) || segs[i] == "" {
			return false
		}
	}
	return len(pat) == len(segs)
}
