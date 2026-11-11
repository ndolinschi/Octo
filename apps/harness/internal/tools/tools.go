package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	"github.com/anthropics/anthropic-sdk-go/v2"
	"github.com/anthropics/anthropic-sdk-go/v2/packages/param"
)

type Handler func(ctx context.Context, input json.RawMessage) (output string, isError bool, err error)

type Def struct {
	Name        string
	Description string
	InputSchema json.RawMessage
	Handle      Handler
}

type Registry struct {
	byName map[string]Def
}

func NewRegistry() *Registry {
	return &Registry{byName: make(map[string]Def)}
}

func (r *Registry) Register(d Def) error {
	if d.Name == "" {
		return fmt.Errorf("tool name required")
	}
	if d.Handle == nil {
		return fmt.Errorf("tool %q: handler required", d.Name)
	}
	if len(d.InputSchema) > 0 {
		var schema anthropic.ToolInputSchemaParam
		if err := json.Unmarshal(d.InputSchema, &schema); err != nil {
			return fmt.Errorf("tool %q: input schema: %w", d.Name, err)
		}
	}
	if _, ok := r.byName[d.Name]; ok {
		return fmt.Errorf("tool %q already registered", d.Name)
	}
	r.byName[d.Name] = d
	return nil
}

func (r *Registry) Get(name string) (Def, bool) {
	d, ok := r.byName[name]
	return d, ok
}

func (r *Registry) AnthropicTools() []anthropic.ToolUnionParam {
	names := make([]string, 0, len(r.byName))
	for name := range r.byName {
		names = append(names, name)
	}
	slices.Sort(names)

	out := make([]anthropic.ToolUnionParam, 0, len(names))
	for _, name := range names {
		d := r.byName[name]
		var schema anthropic.ToolInputSchemaParam
		if len(d.InputSchema) > 0 {
			_ = json.Unmarshal(d.InputSchema, &schema)
		}
		union := anthropic.ToolUnionParamOfTool(schema, name)
		if d.Description != "" {
			union.OfTool.Description = param.NewOpt(d.Description)
		}
		out = append(out, union)
	}
	return out
}

func (r *Registry) All() []Def {
	out := make([]Def, 0, len(r.byName))
	for _, d := range r.byName {
		out = append(out, d)
	}
	slices.SortFunc(out, func(a, b Def) int { return strings.Compare(a.Name, b.Name) })
	return out
}

// Decorate replaces the named tool's handler with wrap(handler); unknown names are ignored.
func (r *Registry) Decorate(name string, wrap func(Handler) Handler) {
	if d, ok := r.byName[name]; ok {
		d.Handle = wrap(d.Handle)
		r.byName[name] = d
	}
}

// Without returns a copy of the registry minus the named tools.
func (r *Registry) Without(names ...string) *Registry {
	out := NewRegistry()
	for n, d := range r.byName {
		if !slices.Contains(names, n) {
			out.byName[n] = d
		}
	}
	return out
}

// Redefine replaces the named tool's definition with f(definition); unknown
// names are ignored.
func (r *Registry) Redefine(name string, f func(Def) Def) {
	if d, ok := r.byName[name]; ok {
		r.byName[name] = f(d)
	}
}
