package plugins

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// Connector registers a plugin's tool server (the --remote contract). A
// failure is recorded on the plugin and never aborts loading.
type Connector func(ctx context.Context, baseURL string) error

// Load reads {dataDir}/plugins/*/plugin.json and every extra dir (either a
// plugin directory itself or a directory of plugin directories). Earlier
// plugins win id clashes. Problems are recorded per plugin; Load never fails.
//
// Built-in plugins (WithBuiltin) load last: a plugin of the same name from a
// directory replaces one, and a built-in agent whose id is already taken is
// skipped without an error.
func Load(ctx context.Context, dataDir string, extraDirs []string, connect Connector, opts ...LoadOption) *Registry {
	b := &builder{
		ctx: ctx, connect: connect,
		reg:   &Registry{plugins: []Plugin{}, agents: map[string]Agent{}, servers: map[string]LanguageServer{}, probes: newProber()},
		names: map[string]string{}, tools: map[string]bool{}, loaded: map[string]bool{},
	}
	b.scan(filepath.Join(dataDir, "plugins"), false)
	for _, d := range extraDirs {
		b.scan(d, true)
	}
	var lo loadOptions
	for _, o := range opts {
		o(&lo)
	}
	for _, bi := range lo.builtins {
		b.loadBuiltin(bi)
	}
	slog.Info("plugins loaded", "plugins", len(b.reg.plugins), "agents", len(b.reg.agents), "language_servers", len(b.reg.servers))
	return b.reg
}

// LoadOption customizes Load.
type LoadOption func(*loadOptions)

type loadOptions struct{ builtins [][]byte }

// WithBuiltin adds a plugin manifest embedded in the binary.
func WithBuiltin(manifest []byte) LoadOption {
	return func(o *loadOptions) { o.builtins = append(o.builtins, manifest) }
}

type builder struct {
	ctx     context.Context
	connect Connector
	reg     *Registry
	names   map[string]string
	tools   map[string]bool
	loaded  map[string]bool
}

// scan loads dir/*/plugin.json; with self set, dir/plugin.json counts too.
func (b *builder) scan(dir string, self bool) {
	if self {
		if _, err := os.Stat(filepath.Join(dir, ManifestName)); err == nil {
			b.load(dir)
			return
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		if !os.IsNotExist(err) || self {
			slog.Warn("plugins dir unreadable", "dir", dir, "err", err)
		}
		return
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	slices.Sort(names)
	for _, n := range names {
		sub := filepath.Join(dir, n)
		if fi, err := os.Stat(filepath.Join(sub, ManifestName)); err == nil && fi.Mode().IsRegular() {
			b.load(sub)
		}
	}
}

func (b *builder) load(dir string) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		abs = dir
	}
	if b.loaded[abs] {
		return
	}
	b.loaded[abs] = true
	p := Plugin{Name: filepath.Base(abs), Dir: abs, LanguageServers: []LanguageServer{}, Agents: []Agent{}, ToolServers: []ToolServer{}, Errors: []string{}}
	data, err := os.ReadFile(filepath.Join(abs, ManifestName))
	var m manifest
	if err == nil {
		m, err = parseManifest(data)
	}
	if err == nil {
		p.Name, p.Version, p.Description = m.Name, m.Version, m.Description
		err = m.validate()
	}
	if err == nil {
		if first, dup := b.names[m.Name]; dup {
			err = fmt.Errorf("duplicate plugin name %q (already loaded from %s)", m.Name, first)
		}
	}
	if err != nil {
		p.Errors = append(p.Errors, err.Error())
		slog.Warn("plugin disabled", "dir", abs, "err", err)
		b.reg.plugins = append(b.reg.plugins, p)
		return
	}
	b.names[m.Name] = abs
	b.populate(&p, m)
	b.reg.plugins = append(b.reg.plugins, p)
}

func (b *builder) loadBuiltin(data []byte) {
	p := Plugin{LanguageServers: []LanguageServer{}, Agents: []Agent{}, ToolServers: []ToolServer{}, Errors: []string{}, Builtin: true}
	m, err := parseManifest(data)
	if err == nil {
		p.Name, p.Version, p.Description = m.Name, m.Version, m.Description
		err = m.validate()
	}
	if err != nil {
		// A programming error: the embedded manifest is checked by a test.
		p.Errors = append(p.Errors, err.Error())
		slog.Warn("built-in plugin disabled", "name", p.Name, "err", err)
		b.reg.plugins = append(b.reg.plugins, p)
		return
	}
	if first, dup := b.names[m.Name]; dup {
		slog.Info("built-in plugin replaced by a plugin directory", "name", m.Name, "dir", first)
		return
	}
	b.names[m.Name] = "(built in)"
	b.populate(&p, m)
	b.reg.plugins = append(b.reg.plugins, p)
}

func (b *builder) populate(p *Plugin, m manifest) {
	for i, s := range m.LanguageServers {
		if err := s.validate(); err != nil {
			p.Errors = append(p.Errors, fmt.Sprintf("languageServers[%d]: %v", i, err))
			continue
		}
		if _, dup := b.reg.servers[s.ID]; dup {
			p.Errors = append(p.Errors, fmt.Sprintf("languageServers[%d]: duplicate language server id %q", i, s.ID))
			continue
		}
		l, ok := launch(s.manifestCommand, p.Dir)
		ls := LanguageServer{ID: s.ID, Label: labelOr(s.Label, s.ID), Languages: slices.Clone(s.Languages), Available: ok, Launch: l}
		b.reg.servers[ls.ID] = ls
		p.LanguageServers = append(p.LanguageServers, ls)
	}
	for i, a := range m.Agents {
		if err := a.validate(); err != nil {
			p.Errors = append(p.Errors, fmt.Sprintf("agents[%d]: %v", i, err))
			continue
		}
		if _, dup := b.reg.agents[a.ID]; dup {
			if p.Builtin {
				slog.Info("built-in agent skipped: id already provided by another plugin", "agent", a.ID)
				continue
			}
			p.Errors = append(p.Errors, fmt.Sprintf("agents[%d]: duplicate agent id %q", i, a.ID))
			continue
		}
		l, ok := launch(a.manifestCommand, p.Dir)
		reason := ""
		if !ok {
			reason = "the agent's program was not found on PATH"
		}
		for _, req := range a.Requires {
			if _, found := resolveCommand(req, p.Dir); !found && ok {
				ok, reason = false, fmt.Sprintf("%q is required and was not found on PATH", req)
			}
		}
		ag := Agent{
			ID: a.ID, Label: labelOr(a.Label, a.ID), Available: ok, UnavailableReason: reason, Launch: l,
			Models: append([]string{}, a.Models...), DefaultModel: a.DefaultModel, ModelArg: slices.Clone(a.ModelArg),
			FlatRate: a.FlatRate != nil && *a.FlatRate, Strengths: slices.Clone(a.Strengths),
		}
		if a.Auth != nil {
			ag.Hint = strings.TrimSpace(a.Auth.Hint)
			ag.AuthMethods, ag.AuthSkip = slices.Clone(a.Auth.Methods), slices.Clone(a.Auth.Skip)
			if len(a.Auth.Probe) > 0 {
				ag.ProbeCommand, _ = resolveCommand(a.Auth.Probe[0], p.Dir)
				ag.ProbeArgs = slices.Clone(a.Auth.Probe[1:])
			}
		}
		b.reg.agents[ag.ID] = ag
		p.Agents = append(p.Agents, ag)
	}
	for i, ts := range m.ToolServers {
		if err := ts.validate(); err != nil {
			p.Errors = append(p.Errors, fmt.Sprintf("toolServers[%d]: %v", i, err))
			continue
		}
		p.ToolServers = append(p.ToolServers, ts)
		b.connectTool(p, ts.URL)
	}
}

func (b *builder) connectTool(p *Plugin, base string) {
	if b.connect == nil || b.tools[base] {
		return
	}
	b.tools[base] = true
	if err := b.connect(b.ctx, base); err != nil {
		slog.Warn("plugin tool server failed", "plugin", p.Name, "url", base, "err", err)
		p.Errors = append(p.Errors, fmt.Sprintf("tool server %s: %v", base, err))
	}
}

func launch(c manifestCommand, dir string) (Launch, bool) {
	path, ok := resolveCommand(c.Command, dir)
	return Launch{Command: path, Args: slices.Clone(c.Args), Env: c.Env, Dir: dir}, ok
}

func labelOr(label, id string) string {
	if label == "" {
		return id
	}
	return label
}
