package inputs

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// A schema form (spec 2026-11-15, Part A): the MCP elicitation schema, a flat
// object of primitive properties, plus Octo's keys under "x-octo".

// Schema limits (refused at validation; the message names the limit).
const (
	MaxSchemaBytes    = 32 << 10
	MaxProperties     = 20
	MaxChoices        = 50
	MaxGroups         = 8
	MaxPropTitle      = 120
	MaxDescription    = 500
	MaxPlaceholder    = 120
	MaxPatternBytes   = 256
	MaxChoiceText     = 200
	MaxSubmitLabel    = 40
	maxSchemaDepth    = 6
	maxSafeInteger    = 1 << 53
	formatEmail       = "email"
	formatURI         = "uri"
	formatDate        = "date"
	formatDateTime    = "date-time"
	FormatPassword    = "password"
	widgetPath        = "path"
	typeString        = "string"
	typeNumber        = "number"
	typeInteger       = "integer"
	typeBoolean       = "boolean"
	typeArray         = "array"
	sourceKindTool    = "tool"
	answerHiddenField = "This field is not shown, so leave it empty"
)

// Origin says who wrote a schema: only a request_input call may ask for a
// password (decision 5).
type Origin string

// Origins of a schema.
const (
	OriginTool       Origin = "tool"
	OriginToolServer Origin = "tool_server"
	OriginReply      Origin = "reply"
)

// Source is where an open form came from.
type Source struct {
	Kind   string `json:"kind"`
	Server string `json:"server,omitempty"`
	Tool   string `json:"tool,omitempty"`
}

// Schema is a parsed, normalised form: x-octo.order lists every property.
type Schema struct {
	Type       string      `json:"type"`
	Properties Properties  `json:"properties"`
	Required   []string    `json:"required,omitempty"`
	Octo       *SchemaOcto `json:"x-octo,omitempty"`
}

// SchemaOcto holds Octo's form-level additions.
type SchemaOcto struct {
	Order       []string `json:"order,omitempty"`
	Groups      []Group  `json:"groups,omitempty"`
	SubmitLabel string   `json:"submit_label,omitempty"`
}

// Group is a titled section of a form.
type Group struct {
	Title  string   `json:"title"`
	Fields []string `json:"fields"`
}

// Choice is one titled option (oneOf, items.anyOf).
type Choice struct {
	Const string `json:"const"`
	Title string `json:"title"`
}

// Items is the item schema of a many-of property.
type Items struct {
	Type      string   `json:"type,omitempty"`
	Enum      []string `json:"enum,omitempty"`
	EnumNames []string `json:"enumNames,omitempty"`
	AnyOf     []Choice `json:"anyOf,omitempty"`
}

// Condition shows a field only while an earlier field equals a value (or any
// of a list of values).
type Condition struct {
	Field  string          `json:"field"`
	Equals json.RawMessage `json:"equals"`
}

// PropertyOcto holds Octo's per-field additions.
type PropertyOcto struct {
	Placeholder string     `json:"placeholder,omitempty"`
	VisibleWhen *Condition `json:"visible_when,omitempty"`
	Multiline   bool       `json:"multiline,omitempty"`
	Step        *float64   `json:"step,omitempty"`
	Widget      string     `json:"widget,omitempty"`
	PathKind    string     `json:"path_kind,omitempty"`
	Accept      bool       `json:"accept,omitempty"`
}

// Property is one field of a form.
type Property struct {
	Type        string          `json:"type"`
	Title       string          `json:"title,omitempty"`
	Description string          `json:"description,omitempty"`
	Format      string          `json:"format,omitempty"`
	Pattern     string          `json:"pattern,omitempty"`
	MinLength   *int            `json:"minLength,omitempty"`
	MaxLength   *int            `json:"maxLength,omitempty"`
	Minimum     *float64        `json:"minimum,omitempty"`
	Maximum     *float64        `json:"maximum,omitempty"`
	Enum        []string        `json:"enum,omitempty"`
	EnumNames   []string        `json:"enumNames,omitempty"`
	OneOf       []Choice        `json:"oneOf,omitempty"`
	Items       *Items          `json:"items,omitempty"`
	MinItems    *int            `json:"minItems,omitempty"`
	MaxItems    *int            `json:"maxItems,omitempty"`
	Default     json.RawMessage `json:"default,omitempty"`
	Octo        *PropertyOcto   `json:"x-octo,omitempty"`
}

// IsPassword reports a secret field.
func (p Property) IsPassword() bool { return p.Type == typeString && p.Format == FormatPassword }

// choices is the set of allowed values of a one-of or many-of field, or nil.
func (p Property) choices() []string {
	switch {
	case len(p.Enum) > 0:
		return p.Enum
	case len(p.OneOf) > 0:
		return consts(p.OneOf)
	case p.Items != nil && len(p.Items.Enum) > 0:
		return p.Items.Enum
	case p.Items != nil:
		return consts(p.Items.AnyOf)
	}
	return nil
}

func consts(cs []Choice) []string {
	out := make([]string, len(cs))
	for i, c := range cs {
		out[i] = c.Const
	}
	return out
}

// NamedProperty is a property with its id.
type NamedProperty struct {
	ID string
	Property
}

// Properties keeps the document order of a schema's properties.
type Properties []NamedProperty

// Get returns the property with that id.
func (ps Properties) Get(id string) (Property, bool) {
	for _, p := range ps {
		if p.ID == id {
			return p.Property, true
		}
	}
	return Property{}, false
}

// MarshalJSON writes the properties as an object in their order.
func (ps Properties) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, p := range ps {
		if i > 0 {
			b.WriteByte(',')
		}
		k, err := json.Marshal(p.ID)
		if err != nil {
			return nil, err
		}
		v, err := json.Marshal(p.Property)
		if err != nil {
			return nil, err
		}
		b.Write(k)
		b.WriteByte(':')
		b.Write(v)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// UnmarshalJSON reads an object token by token, keeping document order. It
// does not validate: ParseSchema does.
func (ps *Properties) UnmarshalJSON(data []byte) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return fmt.Errorf("properties must be an object")
	}
	var out Properties
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return err
		}
		id, _ := tok.(string)
		var p Property
		if err := dec.Decode(&p); err != nil {
			return fmt.Errorf("property %q: %w", id, err)
		}
		out = append(out, NamedProperty{ID: id, Property: p})
	}
	*ps = out
	return nil
}
