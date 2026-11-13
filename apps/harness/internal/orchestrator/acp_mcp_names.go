package orchestrator

import (
	"encoding/json"
	"regexp"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
	"github.com/ndolinschi/Octo/apps/harness/internal/mcp"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
)

// setHarnessTools tells the session which harness tools its agent can call.
func (s *acpSession) setHarnessTools(reg *tools.Registry) {
	m := map[string]json.RawMessage{}
	for _, d := range reg.All() {
		m[d.Name] = d.InputSchema
	}
	s.mu.Lock()
	s.harness = m
	s.mu.Unlock()
}

var (
	mcpDouble = regexp.MustCompile(`^mcp__([^_].*?)__(.+)$`)
	// "octo-harness: spawn_agent", "octo-harness:spawn_agent", "octo-harness__spawn_agent", "octo-harness/spawn_agent"
	mcpPlain = regexp.MustCompile(`^([A-Za-z0-9_.-]+?)(?::\s*|__|/)([A-Za-z0-9_]+)$`)
)

// harnessToolOf recognizes a tool_call that is a call to a harness tool over
// MCP and returns the tool's own name: by the title's shape (mcp__server__tool
// and its common variants, server being the harness's), or, failing that, a
// title that names the tool while the raw input has the tool's required
// arguments and only its properties. Must hold s.mu.
func (s *acpSession) harnessToolOf(call acp.ToolCall) (string, bool) {
	if len(s.harness) == 0 {
		return "", false
	}
	title := strings.TrimSpace(call.Title)
	for _, re := range []*regexp.Regexp{mcpDouble, mcpPlain} {
		if m := re.FindStringSubmatch(title); m != nil && strings.EqualFold(m[1], mcp.ServerName) {
			if _, ok := s.harness[m[2]]; ok {
				return m[2], true
			}
		}
	}
	var in map[string]json.RawMessage
	if len(call.RawInput) == 0 || json.Unmarshal(call.RawInput, &in) != nil || len(in) == 0 {
		return "", false
	}
	for name, schema := range s.harness {
		if !strings.Contains(title, name) || !fitsSchema(in, schema) {
			continue
		}
		return name, true
	}
	return "", false
}

// fitsSchema: every required property is present and nothing outside the properties is.
func fitsSchema(in map[string]json.RawMessage, schema json.RawMessage) bool {
	var sc struct {
		Properties map[string]json.RawMessage `json:"properties"`
		Required   []string                   `json:"required"`
	}
	if json.Unmarshal(schema, &sc) != nil || len(sc.Properties) == 0 {
		return false
	}
	for k := range in {
		if _, ok := sc.Properties[k]; !ok {
			return false
		}
	}
	for _, r := range sc.Required {
		if _, ok := in[r]; !ok {
			return false
		}
	}
	return true
}
