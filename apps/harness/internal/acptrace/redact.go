package acptrace

import (
	"regexp"
	"strings"
)

// secretKey is the childenv rule for names that hold secrets, plus the usual
// header and field names.
var secretKey = regexp.MustCompile(`(?i)(key|token|secret|password|passwd|credential|authorization|cookie|bearer)`)

var bearer = regexp.MustCompile(`(?i)(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}`)

// redactValue walks a decoded JSON value. A string under a key that looks like
// a secret is replaced; so is the "value" of a {name, value} pair whose name
// does (the shape of ACP env and header lists); every other string is scrubbed.
func (t *Trace) redactValue(key string, v any) any {
	switch x := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(x))
		name, _ := x["name"].(string)
		pair := name != "" && hasKey(x, "value")
		for k, val := range x {
			switch {
			case pair && k == "value" && (secretKey.MatchString(name) || strings.EqualFold(name, "authorization")):
				out[k] = Redacted
			case pair && k == "value" && isEnvish(name):
				out[k] = Redacted
			default:
				out[k] = t.redactValue(k, val)
			}
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = t.redactValue(key, e)
		}
		return out
	case string:
		if key != "" && secretKey.MatchString(key) && x != "" {
			return Redacted
		}
		return t.redactString(x)
	default:
		return v
	}
}

func hasKey(m map[string]any, k string) bool { _, ok := m[k]; return ok }

// isEnvish: a name/value pair in an "env" list is an environment variable
// whose value is hidden whatever its name.
var envName = regexp.MustCompile(`^[A-Z][A-Z0-9_]*$`)

func isEnvish(name string) bool { return envName.MatchString(name) }

var assign = regexp.MustCompile(`(?i)([A-Za-z0-9_.-]*(?:key|token|secret|password|passwd|credential)[A-Za-z0-9_.-]*)(=|:\s*)([^\s"',;]+)`)

func (t *Trace) redactString(s string) string {
	t.mu.Lock()
	exact := append([]string(nil), t.exact...)
	t.mu.Unlock()
	for _, v := range exact {
		if strings.Contains(s, v) {
			s = strings.ReplaceAll(s, v, Redacted)
		}
	}
	if t.scrub != nil {
		s = t.scrub(s)
	}
	s = assign.ReplaceAllString(s, "${1}${2}"+Redacted)
	return bearer.ReplaceAllString(s, "$1 "+Redacted)
}
