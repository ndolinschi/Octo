package plugins

import (
	"fmt"
	"strings"
)

// ACPPrefix starts a model setting that names an ACP agent: `acp:<id>` or
// `acp:<id>/<model>`.
const ACPPrefix = "acp:"

// IsACPRef reports whether a model setting names an ACP agent.
func IsACPRef(s string) bool { return strings.HasPrefix(s, ACPPrefix) }

// ParseACPRef splits `acp:<id>[/<model>]`. Agent ids never contain "/", so the
// first slash starts the model (which may itself contain slashes).
func ParseACPRef(s string) (id, model string, ok bool) {
	rest, found := strings.CutPrefix(s, ACPPrefix)
	if !found || rest == "" {
		return "", "", false
	}
	id, model, _ = strings.Cut(rest, "/")
	if id == "" {
		return "", "", false
	}
	return id, model, true
}

// ValidateACPRef checks an `acp:` setting against the loaded agents: the agent
// must exist and be available. Any well-formed model name is accepted, listed
// or not: the agent itself says whether it knows the model when the turn starts.
// Settings without the prefix are not this function's business (nil).
func ValidateACPRef(ref string, agents []Agent) error {
	if !IsACPRef(ref) {
		return nil
	}
	id, model, ok := ParseACPRef(ref)
	if !ok {
		return fmt.Errorf("%q is not a valid ACP setting; use acp:<agent-id> or acp:<agent-id>/<model>", ref)
	}
	var ids []string
	for _, a := range agents {
		if a.ID != id {
			if a.Available {
				ids = append(ids, a.ID)
			}
			continue
		}
		if a.Unsupported != "" {
			return nil // refused as 422 model_unavailable with its reason by the provider check
		}
		if !a.Available {
			why := "its command was not found"
			if a.UnavailableReason != "" {
				why = a.UnavailableReason
			}
			return fmt.Errorf("ACP agent %q is loaded but not available (%s)", id, why)
		}
		switch {
		case model == "":
		case !ModelPattern.MatchString(model):
			return fmt.Errorf("invalid model %q for ACP agent %q", model, id)
		}
		return nil
	}
	known := "none are loaded"
	if len(ids) > 0 {
		known = "available: " + strings.Join(ids, ", ")
	}
	return fmt.Errorf("unknown ACP agent %q in %q (%s)", id, ref, known)
}
