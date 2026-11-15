package inputs

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"slices"
	"unicode/utf8"
)

// Keywords a schema may carry. Annotations in ignored are accepted and
// dropped; any other keyword is refused, naming it.
var (
	schemaKeys   = []string{"type", "properties", "required", "x-octo"}
	schemaIgnore = []string{"$schema", "$id", "$comment", "title", "description", "additionalProperties"}
	propKeys     = []string{"type", "title", "description", "format", "pattern", "minLength", "maxLength", "minimum",
		"maximum", "enum", "enumNames", "oneOf", "items", "minItems", "maxItems", "default", "x-octo"}
	propIgnore     = []string{"$comment", "examples", "uniqueItems"}
	itemsKeys      = []string{"type", "enum", "enumNames", "anyOf"}
	choiceKeys     = []string{"const", "title"}
	schemaOctoKeys = []string{"order", "groups", "submit_label"}
	groupKeys      = []string{"title", "fields"}
	propOctoKeys   = []string{"placeholder", "visible_when", "multiline", "step", "widget", "path_kind", "accept"}
	conditionKeys  = []string{"field", "equals"}
)

// ParseSchema validates a form schema and normalises it: x-octo.order lists
// every property (the given order first, then the rest in document order).
// Errors are *ValidationError naming the cause, never an answer value.
func ParseSchema(raw json.RawMessage, origin Origin) (Schema, error) {
	if len(raw) > MaxSchemaBytes {
		return Schema{}, bad("the form schema is %d bytes; at most %d (32 KiB) are allowed", len(raw), MaxSchemaBytes)
	}
	if err := checkDepth(raw); err != nil {
		return Schema{}, err
	}
	top, err := object(raw, "the schema", schemaKeys, schemaIgnore)
	if err != nil {
		return Schema{}, err
	}
	var s Schema
	if err := field(top, "type", &s.Type, "the schema"); err != nil {
		return Schema{}, err
	}
	if s.Type != "object" {
		return Schema{}, bad(`the schema's type must be "object"`)
	}
	ids, raws, err := orderedObject(top["properties"])
	if err != nil {
		return Schema{}, err
	}
	if len(ids) == 0 || len(ids) > MaxProperties {
		return Schema{}, bad("a form takes 1 to %d properties, this one has %d", MaxProperties, len(ids))
	}
	for i, id := range ids {
		p, err := parseProperty(id, raws[i], origin, s.Properties)
		if err != nil {
			return Schema{}, err
		}
		s.Properties = append(s.Properties, NamedProperty{ID: id, Property: p})
	}
	if err := field(top, "required", &s.Required, "the schema"); err != nil {
		return Schema{}, err
	}
	if err := idList(s.Required, ids, "required"); err != nil {
		return Schema{}, err
	}
	if s.Octo, err = parseSchemaOcto(top["x-octo"], ids); err != nil {
		return Schema{}, err
	}
	return s, nil
}

func parseSchemaOcto(raw json.RawMessage, ids []string) (*SchemaOcto, error) {
	o := &SchemaOcto{}
	if raw != nil {
		m, err := object(raw, "x-octo", schemaOctoKeys, nil)
		if err != nil {
			return nil, err
		}
		if err := field(m, "order", &o.Order, "x-octo"); err != nil {
			return nil, err
		}
		if err := idList(o.Order, ids, "x-octo.order"); err != nil {
			return nil, err
		}
		if err := field(m, "submit_label", &o.SubmitLabel, "x-octo"); err != nil {
			return nil, err
		}
		if utf8.RuneCountInString(o.SubmitLabel) > MaxSubmitLabel {
			return nil, bad("x-octo.submit_label is at most %d characters", MaxSubmitLabel)
		}
		var groups []json.RawMessage
		if err := field(m, "groups", &groups, "x-octo"); err != nil {
			return nil, err
		}
		if len(groups) > MaxGroups {
			return nil, bad("a form takes at most %d groups, this one has %d", MaxGroups, len(groups))
		}
		grouped := map[string]bool{}
		for _, g := range groups {
			gm, err := object(g, "a group", groupKeys, nil)
			if err != nil {
				return nil, err
			}
			var grp Group
			if err := field(gm, "title", &grp.Title, "a group"); err != nil {
				return nil, err
			}
			if err := field(gm, "fields", &grp.Fields, "a group"); err != nil {
				return nil, err
			}
			if err := text(grp.Title, "a group's title", MaxPropTitle, true); err != nil {
				return nil, err
			}
			if len(grp.Fields) == 0 {
				return nil, bad("group %q lists no fields", grp.Title)
			}
			if err := idList(grp.Fields, ids, "group "+grp.Title); err != nil {
				return nil, err
			}
			for _, id := range grp.Fields {
				if grouped[id] {
					return nil, bad("property %q is in two groups", id)
				}
				grouped[id] = true
			}
			o.Groups = append(o.Groups, grp)
		}
	}
	for _, id := range ids {
		if !slices.Contains(o.Order, id) {
			o.Order = append(o.Order, id)
		}
	}
	return o, nil
}

// checkDepth refuses malformed JSON and nesting deeper than any valid form needs.
func checkDepth(raw json.RawMessage) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	depth := 0
	for {
		tok, err := dec.Token()
		if errors.Is(err, io.EOF) && depth == 0 {
			break
		}
		if err != nil {
			return bad("the form schema is not valid JSON: %v", err)
		}
		if d, ok := tok.(json.Delim); ok {
			if d == '{' || d == '[' {
				depth++
				if depth > maxSchemaDepth {
					return bad("the form schema is nested more than %d levels deep; nested objects are not supported", maxSchemaDepth)
				}
			} else {
				depth--
			}
		}
	}
	return nil
}

// object decodes a JSON object and refuses keys outside allowed (ignored keys
// are dropped).
func object(raw json.RawMessage, what string, allowed, ignored []string) (map[string]json.RawMessage, error) {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil || m == nil {
		return nil, bad("%s must be a JSON object", what)
	}
	for k := range m {
		switch {
		case slices.Contains(allowed, k):
		case slices.Contains(ignored, k):
			delete(m, k)
		default:
			return nil, bad("%s: keyword %q is not supported in a form", what, clip(k, 40))
		}
	}
	return m, nil
}

// field decodes m[key] into v when present (null counts as absent).
func field(m map[string]json.RawMessage, key string, v any, what string) error {
	raw, ok := m[key]
	if !ok || string(raw) == "null" {
		return nil
	}
	if err := json.Unmarshal(raw, v); err != nil {
		return bad("%s: %q has the wrong type", what, key)
	}
	return nil
}

// orderedObject reads the properties object, keeping document order and
// refusing duplicate ids.
func orderedObject(raw json.RawMessage) ([]string, []json.RawMessage, error) {
	if raw == nil {
		return nil, nil, bad("the schema needs properties")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return nil, nil, bad("properties must be a JSON object")
	}
	var ids []string
	var raws []json.RawMessage
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return nil, nil, bad("properties are not valid JSON")
		}
		id, _ := tok.(string)
		var v json.RawMessage
		if err := dec.Decode(&v); err != nil {
			return nil, nil, bad("properties are not valid JSON")
		}
		if slices.Contains(ids, id) {
			return nil, nil, bad("duplicate property id %q", clip(id, 64))
		}
		ids, raws = append(ids, id), append(raws, v)
	}
	return ids, raws, nil
}

// idList checks a list of property ids: each known, none twice.
func idList(list, ids []string, what string) error {
	seen := map[string]bool{}
	for _, id := range list {
		if !slices.Contains(ids, id) {
			return bad("%s names %q, which is not a property", what, clip(id, 64))
		}
		if seen[id] {
			return bad("%s names %q twice", what, id)
		}
		seen[id] = true
	}
	return nil
}

func text(s, what string, max int, required bool) error {
	if required && s == "" {
		return bad("%s is required", what)
	}
	if utf8.RuneCountInString(s) > max {
		return bad("%s is at most %d characters", what, max)
	}
	return nil
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n] + "…"
}
