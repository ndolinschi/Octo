// Package plugins loads plugin manifests (language servers, ACP agents, tool
// servers) from disk into an immutable registry. It never executes anything.
package plugins

import (
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strings"
)

// ManifestName is the file a plugin directory must contain.
const ManifestName = "plugin.json"

var (
	namePattern = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
	idPattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

	// ModelPattern is what a model id may look like: it ends up in process
	// arguments and records, so it must not start with a dash or hold spaces.
	ModelPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}$`)
)

// ModelPlaceholder is replaced by the model id in a modelArg template.
const ModelPlaceholder = "{model}"

// ModelArgsPlaceholder is an args element replaced by the expanded modelArg.
const ModelArgsPlaceholder = "{modelArgs}"

type manifest struct {
	Name            string           `json:"name"`
	Version         string           `json:"version"`
	Description     string           `json:"description"`
	LanguageServers []manifestServer `json:"languageServers"`
	Agents          []manifestAgent  `json:"agents"`
	ToolServers     []ToolServer     `json:"toolServers"`
}

type manifestServer struct {
	manifestCommand
	Languages []string `json:"languages"`
}

type manifestAgent struct {
	manifestCommand
	Models       []string      `json:"models"`
	DefaultModel string        `json:"defaultModel"`
	ModelArg     []string      `json:"modelArg"`
	Auth         *manifestAuth `json:"auth"`
	// FlatRate says the agent runs on a flat-rate subscription (no per-token
	// charge at the margin); absent means false. Strengths lists the difficulty
	// bands (easy, medium, hard) the agent suits, for automatic routing.
	FlatRate  *bool    `json:"flatRate"`
	Strengths []string `json:"strengths"`
}

// Strength values a manifest may list.
var validStrengths = []string{"easy", "medium", "hard"}

func validateStrengths(in []string) error {
	seen := map[string]bool{}
	for _, s := range in {
		switch {
		case !slices.Contains(validStrengths, s):
			return fmt.Errorf("strengths: %q must be one of easy, medium, hard", s)
		case seen[s]:
			return fmt.Errorf("strengths: duplicate %q", s)
		}
		seen[s] = true
	}
	return nil
}

// manifestAuth describes how to tell whether an agent's CLI is logged in:
// Probe exits 0 when it is (it must never log in or start a session) and Hint
// is the one-line instruction shown when it is not.
//
// Methods lists the ACP auth method ids to try, in preference order (each a
// string or {"id", "requiresEnv"}); Skip lists ids never to try.
type manifestAuth struct {
	Probe   []string        `json:"probe"`
	Hint    string          `json:"hint"`
	Methods []AuthMethodRef `json:"methods"`
	Skip    []string        `json:"skip"`
}

// AuthMethodRef names an ACP auth method. RequiresEnv, when set, makes the
// method eligible only while that variable is set in the agent's environment.
type AuthMethodRef struct {
	ID          string `json:"id"`
	RequiresEnv string `json:"requiresEnv,omitempty"`
}

// UnmarshalJSON accepts "id" or {"id": "...", "requiresEnv": "NAME"}.
func (r *AuthMethodRef) UnmarshalJSON(data []byte) error {
	var id string
	if err := json.Unmarshal(data, &id); err == nil {
		*r = AuthMethodRef{ID: id}
		return nil
	}
	type plain AuthMethodRef
	var p plain
	if err := json.Unmarshal(data, &p); err != nil {
		return fmt.Errorf("auth method must be a string or an object with id and requiresEnv: %w", err)
	}
	*r = AuthMethodRef(p)
	return nil
}

type manifestCommand struct {
	ID      string            `json:"id"`
	Label   string            `json:"label"`
	Command string            `json:"command"`
	Args    []string          `json:"args"`
	Env     map[string]string `json:"env"`
}

func parseManifest(data []byte) (manifest, error) {
	var m manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return manifest{}, fmt.Errorf("invalid JSON: %w", err)
	}
	return m, nil
}

// validate checks the plugin-level fields; any failure disables the plugin.
func (m manifest) validate() error {
	switch {
	case m.Name == "":
		return fmt.Errorf("name is required")
	case !namePattern.MatchString(m.Name):
		return fmt.Errorf("name %q must match [a-z0-9] words joined by '-'", m.Name)
	case strings.TrimSpace(m.Version) == "":
		return fmt.Errorf("version is required")
	}
	return nil
}

func (s manifestServer) validate() error {
	if err := s.manifestCommand.validate(); err != nil {
		return err
	}
	if len(s.Languages) == 0 || slices.Contains(s.Languages, "") {
		return fmt.Errorf("languages must list at least one language id")
	}
	return nil
}

func (a manifestAgent) validate() error {
	if err := a.manifestCommand.validate(); err != nil {
		return err
	}
	if err := validateModels(a.Models, a.DefaultModel); err != nil {
		return err
	}
	if err := validateStrengths(a.Strengths); err != nil {
		return err
	}
	if len(a.ModelArg) > 0 && !slices.ContainsFunc(a.ModelArg, func(s string) bool { return strings.Contains(s, ModelPlaceholder) }) {
		return fmt.Errorf("modelArg must contain %s", ModelPlaceholder)
	}
	switch n := countOf(a.Args, ModelArgsPlaceholder); {
	case n > 1:
		return fmt.Errorf("args may contain %s only once", ModelArgsPlaceholder)
	case n == 1 && len(a.ModelArg) == 0:
		return fmt.Errorf("args contains %s but modelArg is not set", ModelArgsPlaceholder)
	}
	if a.Auth != nil {
		if len(a.Auth.Probe) == 0 && strings.TrimSpace(a.Auth.Hint) == "" {
			return fmt.Errorf("auth needs a probe, a hint or both")
		}
		if len(a.Auth.Probe) > 0 && strings.TrimSpace(a.Auth.Probe[0]) == "" {
			return fmt.Errorf("auth.probe[0] must be a command")
		}
		if err := a.Auth.validateMethods(); err != nil {
			return err
		}
	}
	return nil
}

func validateModels(models []string, def string) error {
	seen := map[string]bool{}
	for _, m := range models {
		switch {
		case !ModelPattern.MatchString(m):
			return fmt.Errorf("model %q must match %s", m, ModelPattern)
		case seen[m]:
			return fmt.Errorf("duplicate model %q", m)
		}
		seen[m] = true
	}
	switch {
	case def == "":
	case !ModelPattern.MatchString(def):
		return fmt.Errorf("defaultModel %q must match %s", def, ModelPattern)
	case len(models) > 0 && !seen[def]:
		return fmt.Errorf("defaultModel %q is not in models", def)
	}
	return nil
}

func (c manifestCommand) validate() error {
	switch {
	case c.ID == "":
		return fmt.Errorf("id is required")
	case !idPattern.MatchString(c.ID):
		return fmt.Errorf("id %q must match %s", c.ID, idPattern)
	case strings.TrimSpace(c.Command) == "":
		return fmt.Errorf("command is required")
	}
	return validateEnv(c.Env)
}

func (s ToolServer) validate() error {
	u, err := url.Parse(s.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("url %q must be an http(s) URL", s.URL)
	}
	return nil
}

func (a manifestAuth) validateMethods() error {
	seen := map[string]bool{}
	for _, m := range a.Methods {
		switch {
		case strings.TrimSpace(m.ID) == "":
			return fmt.Errorf("auth.methods: id is required")
		case seen[m.ID]:
			return fmt.Errorf("auth.methods: duplicate id %q", m.ID)
		case m.RequiresEnv != "" && !envKeyPat.MatchString(m.RequiresEnv):
			return fmt.Errorf("auth.methods %q: requiresEnv %q is not a valid variable name", m.ID, m.RequiresEnv)
		}
		seen[m.ID] = true
	}
	if slices.Contains(a.Skip, "") {
		return fmt.Errorf("auth.skip: ids must not be empty")
	}
	return nil
}

func countOf(list []string, v string) int {
	n := 0
	for _, s := range list {
		if s == v {
			n++
		}
	}
	return n
}
