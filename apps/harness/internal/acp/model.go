package acp

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"slices"
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
}

type modelState struct {
	CurrentModelID  string `json:"currentModelId"`
	AvailableModels []struct {
		ModelID string `json:"modelId"`
	} `json:"availableModels"`
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

// selectModel makes the session use opts.Model through what the agent
// advertises: a model config option first, then session/set_model.
func (c *Client) selectModel(ctx context.Context, sess newSessionResult, opts RunOptions) error {
	want := opts.Model
	if want == "" {
		return nil
	}
	var ms modelState
	haveModels := len(sess.Models) > 0 && json.Unmarshal(sess.Models, &ms) == nil && len(ms.AvailableModels) > 0
	opt, haveOpt := modelOption(sess.ConfigOptions)
	var err error
	switch {
	case haveOpt && opt.current() == want, haveModels && !haveOpt && ms.CurrentModelID == want:
		return nil
	case haveOpt:
		if !slices.Contains(opt.values(), want) {
			err = fmt.Errorf("the agent offers %s", strings.Join(opt.values(), ", "))
			break
		}
		err = c.conn.call(ctx, methodSetConfig, map[string]string{"sessionId": sess.SessionID, "configId": opt.ID, "value": want}, nil)
	case haveModels:
		err = c.conn.call(ctx, methodSetModel, map[string]string{"sessionId": sess.SessionID, "modelId": want}, nil)
	case opts.ModelApplied:
		return nil
	default:
		err = fmt.Errorf("the agent advertises no model selection")
	}
	if err == nil {
		return nil
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if opts.ModelRequired && !opts.ModelApplied {
		return fmt.Errorf("select model %q: %w", want, err)
	}
	slog.Warn("acp: model not selected; the agent keeps its own", "agent", c.name, "model", want, "err", err)
	return nil
}
