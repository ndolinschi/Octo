package inputs

import (
	"slices"
	"strings"
)

// FromFields converts a legacy form (the five kinds) into a normalised
// schema: text → string; secret → string + password; select → string + enum;
// confirm → boolean (required → x-octo.accept, "must be ticked"); path →
// string + x-octo.widget "path"; label → title; help → description.
// fields must have passed Validate.
func FromFields(fields []Field) Schema {
	s := Schema{Type: "object", Octo: &SchemaOcto{}}
	for _, f := range fields {
		p := Property{Type: typeString, Title: f.Label, Description: f.Help}
		switch f.Kind {
		case KindSecret:
			p.Format = FormatPassword
		case KindSelect:
			p.Enum = append([]string(nil), f.Options...)
		case KindConfirm:
			p.Type = typeBoolean
			if f.Required {
				p.Octo = &PropertyOcto{Accept: true}
			}
		case KindPath:
			p.Octo = &PropertyOcto{Widget: widgetPath}
		}
		s.Properties = append(s.Properties, NamedProperty{ID: f.ID, Property: p})
		s.Octo.Order = append(s.Octo.Order, f.ID)
		if f.Required {
			s.Required = append(s.Required, f.ID)
		}
	}
	return s
}

// ValidateTitle checks a form's title (1 to 200 bytes after trimming).
func ValidateTitle(title string) error {
	if strings.TrimSpace(title) == "" || len(title) > 200 {
		return bad("title is required (at most 200 characters)")
	}
	return nil
}

// Describe is the refusal's technical text: "id: message" per refused field,
// in the form's order, unknown ids last. It names fields, never values.
func Describe(s Schema, errs map[string]string) string {
	var parts []string
	for _, p := range s.Properties {
		if msg, ok := errs[p.ID]; ok {
			parts = append(parts, p.ID+": "+msg)
		}
	}
	var extra []string
	for id, msg := range errs {
		if _, ok := s.Properties.Get(id); !ok {
			extra = append(extra, id+": "+msg)
		}
	}
	slices.Sort(extra)
	return strings.Join(append(parts, extra...), "; ")
}
