package plugins

import (
	"fmt"
	"os"
	"regexp"
	"slices"
	"strings"
)

var (
	envRef    = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)\}`)
	envKeyPat = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
)

// validateEnv checks names and that every "${" in a value starts a complete
// ${NAME} reference.
func validateEnv(env map[string]string) error {
	for _, k := range sortedKeys(env) {
		if !envKeyPat.MatchString(k) {
			return fmt.Errorf("env name %q is not a valid variable name", k)
		}
		if strings.Count(env[k], "${") != len(envRef.FindAllString(env[k], -1)) {
			return fmt.Errorf("env %s: malformed ${NAME} reference", k)
		}
	}
	return nil
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}

// ResolvedEnv expands ${NAME} references against the harness process
// environment. An entry that references a variable that is unset or empty is
// left out entirely, never passed as an empty string.
func (l Launch) ResolvedEnv() map[string]string {
	return expandEnv(l.Env, os.LookupEnv)
}

func expandEnv(env map[string]string, lookup func(string) (string, bool)) map[string]string {
	out := make(map[string]string, len(env))
	for k, v := range env {
		missing := false
		val := envRef.ReplaceAllStringFunc(v, func(ref string) string {
			got, ok := lookup(envRef.FindStringSubmatch(ref)[1])
			if !ok || got == "" {
				missing = true
			}
			return got
		})
		if !missing {
			out[k] = val
		}
	}
	return out
}

// ArgsFor returns the launch arguments with the expanded modelArg template
// for model. A literal "{modelArgs}" element in args marks where it goes (and
// is dropped when no model is chosen); without one the template is appended.
func (a Agent) ArgsFor(model string) []string {
	var expanded []string
	if model != "" {
		for _, t := range a.ModelArg {
			expanded = append(expanded, strings.ReplaceAll(t, ModelPlaceholder, model))
		}
	}
	at := slices.Index(a.Args, ModelArgsPlaceholder)
	if at < 0 {
		return append(slices.Clone(a.Args), expanded...)
	}
	args := make([]string, 0, len(a.Args)+len(expanded))
	args = append(args, a.Args[:at]...)
	args = append(args, expanded...)
	return append(args, slices.DeleteFunc(slices.Clone(a.Args[at+1:]), func(s string) bool { return s == ModelArgsPlaceholder })...)
}
