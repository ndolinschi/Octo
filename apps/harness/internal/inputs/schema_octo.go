package inputs

import (
	"bytes"
	"encoding/json"
	"slices"
)

const maxConditionValues = MaxChoices

func parsePropOcto(raw json.RawMessage, what string, p Property, earlier Properties) (*PropertyOcto, error) {
	if raw == nil {
		return nil, nil
	}
	what += " x-octo"
	m, err := object(raw, what, propOctoKeys, nil)
	if err != nil {
		return nil, err
	}
	o := &PropertyOcto{}
	var cond json.RawMessage
	for key, dst := range map[string]any{
		"placeholder": &o.Placeholder, "multiline": &o.Multiline, "step": &o.Step, "widget": &o.Widget,
		"path_kind": &o.PathKind, "accept": &o.Accept, "visible_when": &cond,
	} {
		if err := field(m, key, dst, what); err != nil {
			return nil, err
		}
	}
	if err := text(o.Placeholder, what+".placeholder", MaxPlaceholder, false); err != nil {
		return nil, err
	}
	plain := p.Type == typeString && p.choices() == nil && p.Format == ""
	switch {
	case o.Multiline && !plain:
		return nil, bad("%s: multiline applies to a plain text field only", what)
	case o.Step != nil && p.Type != typeNumber && p.Type != typeInteger:
		return nil, bad("%s: step applies to a number field only", what)
	case o.Step != nil && *o.Step <= 0:
		return nil, bad("%s: step must be above zero", what)
	case o.Widget != "" && o.Widget != widgetPath:
		return nil, bad(`%s: widget must be "path"`, what)
	case o.Widget != "" && !plain:
		return nil, bad("%s: the path widget applies to a plain text field only", what)
	case o.PathKind != "" && o.Widget != widgetPath:
		return nil, bad("%s: path_kind needs the path widget", what)
	case o.PathKind != "" && o.PathKind != "file" && o.PathKind != "folder":
		return nil, bad(`%s: path_kind must be "file" or "folder"`, what)
	case o.Accept && p.Type != typeBoolean:
		return nil, bad("%s: accept applies to a boolean field only", what)
	}
	if cond != nil && string(cond) != "null" {
		c, err := parseCondition(cond, what, earlier)
		if err != nil {
			return nil, err
		}
		o.VisibleWhen = c
	}
	return o, nil
}

// parseCondition checks visible_when: an earlier, non-password, non-array
// field, and values of that field's type (and among its choices).
func parseCondition(raw json.RawMessage, what string, earlier Properties) (*Condition, error) {
	what += ".visible_when"
	m, err := object(raw, what, conditionKeys, nil)
	if err != nil {
		return nil, err
	}
	c := &Condition{}
	if err := field(m, "field", &c.Field, what); err != nil {
		return nil, err
	}
	ctl, ok := earlier.Get(c.Field)
	switch {
	case c.Field == "":
		return nil, bad("%s needs a field", what)
	case !ok:
		return nil, bad("%s: field %q must be an earlier property", what, clip(c.Field, 64))
	case ctl.IsPassword():
		return nil, bad("%s cannot depend on a password", what)
	case ctl.Type == typeArray:
		return nil, bad("%s cannot depend on a many-of field", what)
	}
	c.Equals = bytes.TrimSpace(m["equals"])
	vals, err := conditionValues(c.Equals)
	if err != nil {
		return nil, bad("%s: equals must be a string, number or boolean, or a list of them (at most %d)", what, maxConditionValues)
	}
	for _, v := range vals {
		var fits bool
		switch v := v.(type) {
		case string:
			fits = ctl.Type == typeString && (ctl.choices() == nil || slices.Contains(ctl.choices(), v))
		case float64:
			fits = ctl.Type == typeNumber || ctl.Type == typeInteger
		case bool:
			fits = ctl.Type == typeBoolean
		}
		if !fits {
			return nil, bad("%s: equals holds a value field %q can never have", what, c.Field)
		}
	}
	return c, nil
}

// conditionValues is equals as a list of scalars.
func conditionValues(raw json.RawMessage) ([]any, error) {
	var v any
	if len(raw) == 0 || json.Unmarshal(raw, &v) != nil {
		return nil, errBadCondition
	}
	list, isList := v.([]any)
	if !isList {
		list = []any{v}
	}
	if len(list) == 0 || len(list) > maxConditionValues {
		return nil, errBadCondition
	}
	for _, x := range list {
		switch x.(type) {
		case string, float64, bool:
		default:
			return nil, errBadCondition
		}
	}
	return list, nil
}

var errBadCondition = bad("bad condition")

// visible reports whether a field with condition c is shown, given the
// answer's raw values and the visibility of earlier fields.
func visible(c *Condition, values map[string]any, shown map[string]bool) bool {
	if c == nil {
		return true
	}
	if !shown[c.Field] {
		return false
	}
	want, err := conditionValues(c.Equals)
	if err != nil {
		return false
	}
	got := values[c.Field]
	for _, w := range want {
		if w == got {
			return true
		}
	}
	return false
}
