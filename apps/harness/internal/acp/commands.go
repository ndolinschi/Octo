package acp

import (
	"encoding/json"
	"strings"
)

// Command is one slash command an agent advertises with the
// available_commands_update session update.
type Command struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	// InputHint is the hint of the command's input ("" when it takes none).
	InputHint string `json:"input_hint,omitempty"`
}

// ParseCommands reads the update's availableCommands in every shape agents
// send: the schema's {name, description, input: {hint}}, and the looser forms
// (input as a bare string, hint / inputHint / input_hint beside the name, a
// name with its leading slash, an array of bare names). Entries without a name
// are dropped, repeated names keep their first entry, order is kept.
func ParseCommands(raw json.RawMessage) []Command {
	var list []json.RawMessage
	if json.Unmarshal(raw, &list) != nil {
		return nil
	}
	out := []Command{}
	seen := map[string]bool{}
	for _, item := range list {
		c, ok := parseCommand(item)
		if !ok || seen[c.Name] {
			continue
		}
		seen[c.Name] = true
		out = append(out, c)
	}
	return out
}

func parseCommand(raw json.RawMessage) (Command, bool) {
	var bare string
	if json.Unmarshal(raw, &bare) == nil {
		name := cleanCommandName(bare)
		return Command{Name: name}, name != ""
	}
	var e struct {
		Name        string          `json:"name"`
		Description string          `json:"description"`
		Input       json.RawMessage `json:"input"`
		Hint        string          `json:"hint"`
		InputHint   string          `json:"inputHint"`
		InputHint2  string          `json:"input_hint"`
	}
	if json.Unmarshal(raw, &e) != nil {
		return Command{}, false
	}
	c := Command{Name: cleanCommandName(e.Name), Description: strings.TrimSpace(e.Description)}
	if c.Name == "" {
		return Command{}, false
	}
	for _, h := range []string{inputHint(e.Input), e.Hint, e.InputHint, e.InputHint2} {
		if h = strings.TrimSpace(h); h != "" {
			c.InputHint = h
			break
		}
	}
	return c, true
}

// inputHint reads the schema's input object ({hint}) or a plain string.
func inputHint(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var o struct {
		Hint string `json:"hint"`
	}
	if json.Unmarshal(raw, &o) == nil {
		return o.Hint
	}
	return ""
}

func cleanCommandName(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimLeft(s, "/")
	if i := strings.IndexAny(s, " \t\r\n"); i >= 0 {
		s = s[:i]
	}
	return s
}
