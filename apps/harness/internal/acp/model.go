package acp

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
)

// RunOptions tunes one Run. The zero value is a plain run with the agent's
// own model and no login hint.
type RunOptions struct {
	// Model is the model id to use; empty leaves the agent's choice.
	Model string
	// ModelRequired fails the run when the agent offers no way to select
	// Model (or refuses it); otherwise a model that cannot be selected is
	// logged and the agent's own model is used.
	ModelRequired bool
	// ModelApplied says Model was already passed at start-up (a modelArg), so
	// protocol-level selection is best effort.
	ModelApplied bool
	// AuthHint is appended to the error when the agent needs a login.
	AuthHint string
	// OnModels, when set, is told the models the agent advertised in the
	// session it just opened (its model config option or model list) and the
	// one it currently uses; it is not called for an agent that advertises none.
	OnModels func(models []AdvertisedModel, current string)
	// Auth restricts and orders the auth methods tried when the agent
	// refuses the session.
	Auth AuthPolicy
}

type modelState struct {
	CurrentModelID  string      `json:"currentModelId"`
	AvailableModels []modelInfo `json:"availableModels"`
}

// modelInfo is one entry of a session's model list: the ACP schema's ModelInfo
// ({modelId, name}); `id` is accepted for agents that name it so.
type modelInfo struct {
	ModelID string `json:"modelId"`
	ID      string `json:"id"`
	Name    string `json:"name"`
}

func (m modelInfo) id() string {
	if m.ModelID != "" {
		return m.ModelID
	}
	return m.ID
}

// parseModelState reads a session's model list from every shape agents send:
// the schema's object ({currentModelId, availableModels}) or a bare array of
// entries or ids.
func parseModelState(raw json.RawMessage) (modelState, bool) {
	if len(raw) == 0 {
		return modelState{}, false
	}
	var ms modelState
	if json.Unmarshal(raw, &ms) == nil && len(ms.AvailableModels) > 0 {
		return ms, true
	}
	var infos []modelInfo
	if json.Unmarshal(raw, &infos) == nil && len(infos) > 0 {
		return modelState{AvailableModels: infos}, true
	}
	var ids []string
	if json.Unmarshal(raw, &ids) == nil && len(ids) > 0 {
		var out modelState
		for _, id := range ids {
			out.AvailableModels = append(out.AvailableModels, modelInfo{ModelID: id})
		}
		return out, true
	}
	return modelState{CurrentModelID: ms.CurrentModelID}, false
}

// AdvertisedModel is a model an agent says a session can use.
type AdvertisedModel struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

// advertised lists what a new session offers: the model config option's values,
// else the session's model list; with the one in use.
func advertised(sess newSessionResult) ([]AdvertisedModel, string) {
	if opt, ok := modelOption(sess.ConfigOptions); ok {
		var out []AdvertisedModel
		var walk func([]optionEntry)
		walk = func(es []optionEntry) {
			for _, e := range es {
				if e.Value != "" {
					out = append(out, AdvertisedModel{ID: e.Value, Label: cmpLabel(e.Name, e.Value)})
				}
				walk(e.Options)
			}
		}
		walk(opt.Options)
		if len(out) > 0 {
			return out, opt.current()
		}
	}
	if ms, ok := parseModelState(sess.Models); ok {
		return modelsOf(ms), ms.CurrentModelID
	}
	// Some agents nest the list under the result's _meta.
	var meta struct {
		Models json.RawMessage `json:"models"`
	}
	if len(sess.Meta) > 0 && json.Unmarshal(sess.Meta, &meta) == nil {
		if ms, ok := parseModelState(meta.Models); ok {
			return modelsOf(ms), ms.CurrentModelID
		}
	}
	return nil, ""
}

func modelsOf(ms modelState) []AdvertisedModel {
	var out []AdvertisedModel
	for _, m := range ms.AvailableModels {
		if id := m.id(); id != "" {
			out = append(out, AdvertisedModel{ID: id, Label: cmpLabel(m.Name, id)})
		}
	}
	return out
}

func cmpLabel(name, id string) string {
	if strings.TrimSpace(name) != "" {
		return name
	}
	return id
}

type configOption struct {
	ID           string          `json:"id"`
	Category     string          `json:"category"`
	CurrentValue json.RawMessage `json:"currentValue"`
	Options      []optionEntry   `json:"options"`
}

// optionEntry is a select value, or a group holding values.
type optionEntry struct {
	Value   string        `json:"value"`
	Name    string        `json:"name"`
	Options []optionEntry `json:"options"`
}

func (o configOption) values() []string {
	var out []string
	var walk func([]optionEntry)
	walk = func(es []optionEntry) {
		for _, e := range es {
			if e.Value != "" {
				out = append(out, e.Value)
			}
			walk(e.Options)
		}
	}
	walk(o.Options)
	return out
}

func (o configOption) current() string {
	var s string
	if json.Unmarshal(o.CurrentValue, &s) != nil {
		return ""
	}
	return s
}

// modelOption finds the session's model selector among its config options.
func modelOption(raw []json.RawMessage) (configOption, bool) {
	for _, r := range raw {
		var o configOption
		if err := json.Unmarshal(r, &o); err != nil {
			continue
		}
		if o.Category == "model" || (o.Category == "" && o.ID == "model") {
			return o, true
		}
	}
	return configOption{}, false
}

// ModelError says the agent did not take the model that was asked for. Offers
// are the models its new session advertised (none when it advertised none).
type ModelError struct {
	Model  string
	Offers []string
	Cause  error
}

func (e *ModelError) Error() string {
	msg := fmt.Sprintf("select model %q: %v", e.Model, e.Cause)
	if len(e.Offers) > 0 {
		msg += "; the agent offers " + strings.Join(e.Offers, ", ")
	}
	return msg
}

func (e *ModelError) Unwrap() error { return e.Cause }

// selectModel makes the session use opts.Model through what the agent
// advertises: a model config option first, then session/set_model. A model the
// agent did not list is still sent (the user may type any name): the agent says
// whether it knows it.
func (c *Client) selectModel(ctx context.Context, sess newSessionResult, opts RunOptions) error {
	models, cur := advertised(sess)
	if opts.OnModels != nil && len(models) > 0 {
		opts.OnModels(models, cur)
	}
	want := opts.Model
	if want == "" {
		return nil
	}
	offers := make([]string, len(models))
	for i, m := range models {
		offers[i] = m.ID
	}
	ms, haveModels := parseModelState(sess.Models)
	opt, haveOpt := modelOption(sess.ConfigOptions)
	var err error
	switch {
	case haveOpt && opt.current() == want, haveModels && !haveOpt && ms.CurrentModelID == want:
		return nil
	case haveOpt:
		err = c.conn.call(ctx, methodSetConfig, map[string]string{"sessionId": sess.SessionID, "configId": opt.ID, "value": want}, nil)
	case opts.ModelApplied:
		return nil
	default:
		// Either a model list, or nothing at all: session/set_model is the one
		// method left to try, and an agent without it answers with an error.
		err = c.conn.call(ctx, methodSetModel, map[string]string{"sessionId": sess.SessionID, "modelId": want}, nil)
	}
	if err == nil {
		return nil
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if opts.ModelRequired && !opts.ModelApplied {
		return &ModelError{Model: want, Offers: offers, Cause: err}
	}
	slog.Warn("acp: model not selected; the agent keeps its own", "agent", c.name, "model", want, "err", err)
	return nil
}

// Discover asks the agent for the models it offers without using it: it opens a
// session at cwd with no MCP servers and reads the models the answer lists,
// then returns. No prompt is sent. The caller closes the Client.
func (c *Client) Discover(ctx context.Context, cwd string, opts RunOptions) (models []AdvertisedModel, current string, err error) {
	sess, err := c.newSession(ctx, cwd, nil, opts.AuthHint, opts.Auth)
	if err != nil {
		return nil, "", err
	}
	models, current = advertised(sess)
	return models, current, nil
}
