package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"

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
