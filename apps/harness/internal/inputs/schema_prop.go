package inputs

import (
	"encoding/json"
	"fmt"
	"regexp"
	"slices"

	"github.com/ndolinschi/Octo/apps/harness/internal/secrets"
)

var formats = []string{formatEmail, formatURI, formatDate, formatDateTime, FormatPassword}

// Keywords that apply to one kind of field only (besides type, title,
// description, default and x-octo).
var (
	plainStringKeys = []string{"format", "pattern", "minLength", "maxLength"}
	oneOfKeys       = []string{"enum", "enumNames", "oneOf"}
	numberKeys      = []string{"minimum", "maximum"}
	arrayKeys       = []string{"items", "minItems", "maxItems"}
)

func parseProperty(id string, raw json.RawMessage, origin Origin, earlier Properties) (Property, error) {
	if !fieldID.MatchString(id) {
		return Property{}, bad("property id %q must start with a letter and use letters, digits, _ . - (at most 64)", clip(id, 64))
	}
	what := fmt.Sprintf("property %q", id)
	var peek struct {
		Type any `json:"type"`
	}
	if json.Unmarshal(raw, &peek) == nil && peek.Type == "object" {
		return Property{}, bad("%s: nested objects are not supported in a form", what)
	}
	m, err := object(raw, what, propKeys, propIgnore)
	if err != nil {
		return Property{}, err
	}
	var p Property
	var items, octo json.RawMessage
	for key, dst := range map[string]any{
		"type": &p.Type, "title": &p.Title, "description": &p.Description, "format": &p.Format, "pattern": &p.Pattern,
		"minLength": &p.MinLength, "maxLength": &p.MaxLength, "minimum": &p.Minimum, "maximum": &p.Maximum,
		"enum": &p.Enum, "enumNames": &p.EnumNames, "minItems": &p.MinItems, "maxItems": &p.MaxItems,
		"items": &items, "x-octo": &octo,
	} {
		if err := field(m, key, dst, what); err != nil {
			return Property{}, err
		}
	}
	if err := choiceList(m["oneOf"], &p.OneOf, what+" oneOf"); err != nil {
		return Property{}, err
	}
	if d, ok := m["default"]; ok && string(d) != "null" {
		p.Default = d
	}
	if err := text(p.Title, what+": title", MaxPropTitle, false); err != nil {
		return Property{}, err
	}
	if err := text(p.Description, what+": description", MaxDescription, false); err != nil {
		return Property{}, err
	}
	var own []string
	switch p.Type {
	case typeString:
		own, err = checkStringProp(id, what, &p, origin)
	case typeNumber, typeInteger:
		own = numberKeys
		if p.Minimum != nil && p.Maximum != nil && *p.Minimum > *p.Maximum {
			err = bad("%s: minimum is above maximum", what)
		}
	case typeBoolean:
	case typeArray:
		own = arrayKeys
		err = checkArrayProp(what, &p, items)
	case "object":
		err = bad("%s: nested objects are not supported in a form", what)
	case "":
		err = bad("%s needs a type", what)
	default:
		err = bad("%s: type %q is not supported (string, number, integer, boolean, array)", what, clip(p.Type, 20))
	}
	if err != nil {
		return Property{}, err
	}
	for k := range m {
		kindOnly := slices.Contains(plainStringKeys, k) || slices.Contains(oneOfKeys, k) ||
			slices.Contains(numberKeys, k) || slices.Contains(arrayKeys, k)
		if kindOnly && !slices.Contains(own, k) {
			return Property{}, bad("%s: %q does not apply to this kind of field", what, k)
		}
	}
	if p.Octo, err = parsePropOcto(octo, what, p, earlier); err != nil {
		return Property{}, err
	}
	if p.Default != nil {
		if p.IsPassword() {
			return Property{}, bad("%s: a password cannot have a default", what)
		}
		var v any
		if err := json.Unmarshal(p.Default, &v); err != nil {
			return Property{}, bad("%s: default is not valid JSON", what)
		}
		if _, msg := checkValue(p, v); msg != "" {
			return Property{}, bad("%s: the default does not fit the field (%s)", what, msg)
		}
	}
	return p, nil
}

func checkStringProp(id, what string, p *Property, origin Origin) ([]string, error) {
	switch {
	case len(p.Enum) > 0 && len(p.OneOf) > 0:
		return nil, bad("%s: use enum or oneOf, not both", what)
	case len(p.Enum) > 0 || len(p.OneOf) > 0:
		if len(p.EnumNames) > 0 && len(p.EnumNames) != len(p.Enum) {
			return nil, bad("%s: enumNames must have one name per enum value", what)
		}
		return oneOfKeys, checkChoices(what, p.choices(), append(slices.Clone(p.EnumNames), titles(p.OneOf)...))
	case len(p.EnumNames) > 0:
		return nil, bad("%s: enumNames needs enum", what)
	}
	if p.Format != "" && !slices.Contains(formats, p.Format) {
		return nil, bad("%s: format %q is not supported (email, uri, date, date-time, password)", what, clip(p.Format, 20))
	}
	if p.IsPassword() {
		if origin != OriginTool {
			return nil, bad("%s: only request_input may ask for a password", what)
		}
		if !secrets.ValidName(id) {
			return nil, bad("%s cannot name a secret", what)
		}
	}
	for _, n := range []*int{p.MinLength, p.MaxLength} {
		if n != nil && *n < 0 {
			return nil, bad("%s: lengths cannot be negative", what)
		}
	}
	if p.MinLength != nil && p.MaxLength != nil && *p.MinLength > *p.MaxLength {
		return nil, bad("%s: minLength is above maxLength", what)
	}
	if len(p.Pattern) > MaxPatternBytes {
		return nil, bad("%s: pattern is at most %d bytes", what, MaxPatternBytes)
	}
	if _, err := regexp.Compile(p.Pattern); err != nil {
		return nil, bad("%s: pattern does not compile as an RE2 regular expression", what)
	}
	return plainStringKeys, nil
}

func checkArrayProp(what string, p *Property, raw json.RawMessage) error {
	if raw == nil {
		return bad("%s: an array needs items", what)
	}
	m, err := object(raw, what+" items", itemsKeys, nil)
	if err != nil {
		return err
	}
	it := &Items{}
	if err := field(m, "type", &it.Type, what+" items"); err != nil {
		return err
	}
	if err := field(m, "enum", &it.Enum, what+" items"); err != nil {
		return err
	}
	if err := field(m, "enumNames", &it.EnumNames, what+" items"); err != nil {
		return err
	}
	if err := choiceList(m["anyOf"], &it.AnyOf, what+" items anyOf"); err != nil {
		return err
	}
	switch {
	case it.Type == "object":
		return bad("%s: arrays of objects are not supported in a form", what)
	case it.Type != "" && it.Type != typeString:
		return bad("%s: items must be strings", what)
	case len(it.Enum) > 0 && len(it.AnyOf) > 0:
		return bad("%s: items take enum or anyOf, not both", what)
	case len(it.Enum) == 0 && len(it.AnyOf) == 0:
		return bad("%s: items need enum or anyOf choices", what)
	case len(it.Enum) > 0 && it.Type != typeString:
		return bad(`%s: items with enum need "type": "string"`, what)
	case len(it.EnumNames) > 0 && len(it.EnumNames) != len(it.Enum):
		return bad("%s: items enumNames must have one name per enum value", what)
	}
	p.Items = it
	if err := checkChoices(what, p.choices(), append(slices.Clone(it.EnumNames), titles(it.AnyOf)...)); err != nil {
		return err
	}
	for _, n := range []*int{p.MinItems, p.MaxItems} {
		if n != nil && *n < 0 {
			return bad("%s: item counts cannot be negative", what)
		}
	}
	if p.MinItems != nil && p.MaxItems != nil && *p.MinItems > *p.MaxItems {
		return bad("%s: minItems is above maxItems", what)
	}
	if p.MinItems != nil && *p.MinItems > len(p.choices()) {
		return bad("%s: minItems is above the number of choices", what)
	}
	return nil
}

func checkChoices(what string, values, names []string) error {
	if len(values) == 0 || len(values) > MaxChoices {
		return bad("%s takes 1 to %d choices, this one has %d", what, MaxChoices, len(values))
	}
	seen := map[string]bool{}
	for _, v := range values {
		if err := text(v, what+": a choice", MaxChoiceText, false); err != nil {
			return err
		}
		if seen[v] {
			return bad("%s: choice %q is listed twice", what, clip(v, 40))
		}
		seen[v] = true
	}
	for _, n := range names {
		if err := text(n, what+": a choice's title", MaxChoiceText, true); err != nil {
			return err
		}
	}
	return nil
}

// choiceList decodes [{const, title}], refusing other keys.
func choiceList(raw json.RawMessage, dst *[]Choice, what string) error {
	if raw == nil || string(raw) == "null" {
		return nil
	}
	var list []json.RawMessage
	if err := json.Unmarshal(raw, &list); err != nil {
		return bad("%s must be a list of {const, title}", what)
	}
	if len(list) > MaxChoices {
		return bad("%s takes 1 to %d choices, this one has %d", what, MaxChoices, len(list))
	}
	for _, c := range list {
		m, err := object(c, what, choiceKeys, nil)
		if err != nil {
			return err
		}
		var ch Choice
		if field(m, "const", &ch.Const, what) != nil || field(m, "title", &ch.Title, what) != nil || m["const"] == nil {
			return bad("%s: each choice needs a string const and title", what)
		}
		*dst = append(*dst, ch)
	}
	return nil
}

func titles(cs []Choice) []string {
	out := make([]string, len(cs))
	for i, c := range cs {
		out[i] = c.Title
	}
	return out
}
