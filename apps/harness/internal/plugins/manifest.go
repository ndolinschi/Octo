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
)

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

type manifestAgent struct{ manifestCommand }

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

func (c manifestCommand) validate() error {
	switch {
	case c.ID == "":
		return fmt.Errorf("id is required")
	case !idPattern.MatchString(c.ID):
		return fmt.Errorf("id %q must match %s", c.ID, idPattern)
	case strings.TrimSpace(c.Command) == "":
		return fmt.Errorf("command is required")
	}
	return nil
}

func (s ToolServer) validate() error {
	u, err := url.Parse(s.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("url %q must be an http(s) URL", s.URL)
	}
	return nil
}
