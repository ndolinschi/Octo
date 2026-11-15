package fakeacp

import (
	"encoding/json"
	"fmt"
	"os"
)

func (a *agent) currentModel() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.model
}

// sessionResult is the session/new answer, advertising models when configured.
func (a *agent) sessionResult() map[string]any {
	res := map[string]any{"sessionId": a.sid()}
	if modes := a.opts.modes(); len(modes) > 0 {
		a.mu.Lock()
		cur := a.mode
		a.mu.Unlock()
		res["modes"] = map[string]any{"currentModeId": cur, "availableModes": modes}
	}
	if len(a.opts.models) == 0 || a.opts.via == "none" {
		return res
	}
	cur := a.currentModel()
	switch a.opts.via {
	case "agy":
		res["configOptions"] = a.agyConfigOptions(cur)
		return res
	case "config", "config-grouped":
		options := make([]map[string]string, len(a.opts.models))
		for i, m := range a.opts.models {
			options[i] = map[string]string{"value": m, "name": m}
		}
		var offered any = options
		if a.opts.via == "config-grouped" {
			half := (len(options) + 1) / 2
			offered = []map[string]any{
				{"group": "first", "name": "First", "options": options[:half]},
				{"group": "second", "name": "Second", "options": options[half:]},
			}
		}
		res["configOptions"] = []any{
			map[string]any{"id": "mode", "name": "Mode", "category": "mode", "type": "select", "currentValue": "default",
				"options": []map[string]string{{"value": "default", "name": "Default"}}},
			map[string]any{"id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": cur, "options": offered},
		}
		return res
	case "models-array":
		list := make([]map[string]string, len(a.opts.models))
		for i, m := range a.opts.models {
			list[i] = map[string]string{"id": m, "name": m}
		}
		res["models"] = list
		return res
	}
	available := make([]map[string]string, len(a.opts.models))
	for i, m := range a.opts.models {
		available[i] = map[string]string{"modelId": m, "name": m}
	}
	state := map[string]any{"currentModelId": cur, "availableModels": available}
	if a.opts.via == "meta" {
		res["_meta"] = map[string]any{"models": state}
		return res
	}
	res["models"] = state
	return res
}

func (a *agent) handleAuthenticate(m message) {
	var p struct {
		MethodID string `json:"methodId"`
	}
	if err := json.Unmarshal(m.Params, &p); err == nil && a.opts.auth == authCustom {
		a.authenticateCustom(m, p.MethodID)
		return
	}
	if a.opts.auth == authAgy {
		a.authenticateAgy(m, p.MethodID)
		return
	}
	if err := json.Unmarshal(m.Params, &p); err != nil || p.MethodID != AuthUnattended || a.opts.auth != "ok" {
		a.respondError(m.ID, -32602, "unknown or unsupported auth method")
		return
	}
	if a.opts.loginFile != "" {
		if _, err := os.Stat(a.opts.loginFile); err != nil {
			a.respondError(m.ID, -32000, "not logged in")
			return
		}
	}
	a.mu.Lock()
	a.authed = true
	a.mu.Unlock()
	a.respond(m.ID, map[string]any{})
}

// handleSetModel serves session/set_model and session/set_config_option.
func (a *agent) handleSetModel(m message) {
	var p struct {
		ModelID  string `json:"modelId"`
		ConfigID string `json:"configId"`
		Value    string `json:"value"`
	}
	if err := json.Unmarshal(m.Params, &p); err != nil {
		a.respondError(m.ID, -32602, "invalid params")
		return
	}
	if p.ConfigID != "" && p.ConfigID != "model" && a.opts.profile == ProfileAgy {
		a.respond(m.ID, map[string]any{}) // the thinking level: accepted, not modelled
		return
	}
	if p.ModelID == "" {
		p.ModelID = p.Value
	}
	if p.ModelID == "" || (a.opts.refuseUnk && !a.opts.knows(p.ModelID)) {
		a.respondError(m.ID, -32602, "unknown model "+p.ModelID)
		return
	}
	a.mu.Lock()
	a.model = p.ModelID
	a.mu.Unlock()
	a.respond(m.ID, map[string]any{})
}

// logRequest appends one line about a request to the file named by EnvRequestLog.
func (a *agent) logRequest(m message) {
	path := os.Getenv(EnvRequestLog)
	if path == "" {
		return
	}
	line := m.Method
	if m.Method == "session/new" {
		var p struct {
			Cwd        string
			McpServers []json.RawMessage
		}
		_ = json.Unmarshal(m.Params, &p)
		line += fmt.Sprintf(" cwd=%s mcp=%d", p.Cwd, len(p.McpServers))
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = fmt.Fprintln(f, line)
}
