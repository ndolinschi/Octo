package plugins

import "slices"

// Registry is the immutable result of Load; safe for concurrent reads.
type Registry struct {
	plugins []Plugin
	agents  map[string]Agent
	servers map[string]LanguageServer
}

// Plugins returns every loaded plugin in load order, including broken ones.
func (r *Registry) Plugins() []Plugin {
	if r == nil {
		return []Plugin{}
	}
	return slices.Clone(r.plugins)
}

// Agents lists every ACP agent in load order, available or not.
func (r *Registry) Agents() []Agent {
	out := []Agent{}
	if r == nil {
		return out
	}
	for _, p := range r.plugins {
		out = append(out, p.Agents...)
	}
	return out
}

// Agent looks up an ACP agent by id.
func (r *Registry) Agent(id string) (Agent, bool) {
	if r == nil {
		return Agent{}, false
	}
	a, ok := r.agents[id]
	return a, ok
}

// LanguageServers lists every language server in load order.
func (r *Registry) LanguageServers() []LanguageServer {
	out := []LanguageServer{}
	if r == nil {
		return out
	}
	for _, p := range r.plugins {
		out = append(out, p.LanguageServers...)
	}
	return out
}

// LanguageServer looks up a language server by id.
func (r *Registry) LanguageServer(id string) (LanguageServer, bool) {
	if r == nil {
		return LanguageServer{}, false
	}
	s, ok := r.servers[id]
	return s, ok
}

// ToolServers lists the tool server URLs of every valid plugin.
func (r *Registry) ToolServers() []string {
	out := []string{}
	if r == nil {
		return out
	}
	for _, p := range r.plugins {
		for _, ts := range p.ToolServers {
			out = append(out, ts.URL)
		}
	}
	return out
}
