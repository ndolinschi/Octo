package fakeacp

import (
	"encoding/json"
	"os"
)

func (a *agent) currentModel() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.model
}

// sessionResult is the session/new answer, advertising models when configured.
func (a *agent) sessionResult() map[string]any {
	res := map[string]any{"sessionId": sessionID}
	if len(a.opts.models) == 0 {
		return res
	}
	cur := a.currentModel()
	if a.opts.viaConfig {
		options := make([]map[string]string, len(a.opts.models))
		for i, m := range a.opts.models {
			options[i] = map[string]string{"value": m, "name": m}
		}
		res["configOptions"] = []any{
			map[string]any{"id": "mode", "name": "Mode", "category": "mode", "type": "select", "currentValue": "default",
				"options": []map[string]string{{"value": "default", "name": "Default"}}},
			map[string]any{"id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": cur, "options": options},
		}
		return res
	}
	available := make([]map[string]string, len(a.opts.models))
	for i, m := range a.opts.models {
		available[i] = map[string]string{"modelId": m, "name": m}
	}
	res["models"] = map[string]any{"currentModelId": cur, "availableModels": available}
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
