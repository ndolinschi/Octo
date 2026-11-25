package orchestrator

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/activity"

	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/inputs"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/secrets"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// ToolRequestInput is the tool an agent calls to ask the user for structured
// or secret input (decision 43).
const ToolRequestInput = "request_input"

// redact removes the project's secret values from text about to be stored,
// published or handed to the model.
// Redact replaces the project's stored secret values in s with their marker.
func (o *Orchestrator) Redact(projectID, s string) string { return o.secrets.Redact(projectID, s) }

func (rt *runtime) redact(s string) string { return rt.o.secrets.Redact(rt.pid(), s) }

// redactProblem is a copy of e with the project's secret values removed from
// every text of it.
func (rt *runtime) redactProblem(e *usererr.Error) *usererr.Error {
	c := *e
	c.Message, c.Hint, c.Command, c.Details = rt.redact(e.Message), rt.redact(e.Hint), rt.redact(e.Command), rt.redact(e.Details)
	return &c
}

// Inputs lists the project's open forms.
func (o *Orchestrator) Inputs(pid string) []inputs.Input { return o.inputs.List(pid) }

// SubmitInput answers an open form. Secret values go to the project's secret
// store before the agent is released; the event and the agent's result carry
// only names.
func (o *Orchestrator) SubmitInput(pid, id string, a inputs.Answer) error {
	return o.inputs.Submit(pid, id, a, func(r inputs.Result) error {
		names := make([]string, 0, len(r.Secrets))
		for name, value := range r.Secrets {
			if err := o.secrets.Put(pid, name, value); err != nil {
				return err
			}
			names = append(names, name)
		}
		if len(names) > 0 {
			sort.Strings(names)
			o.hub.Publish(pid, events.SecretsChanged, map[string]any{"names": names})
		}
		return nil
	})
}

// Secrets lists the names of the project's secrets.
func (o *Orchestrator) Secrets(pid string) ([]secrets.Info, error) { return o.secrets.List(pid) }

// PutSecret stores a secret (a form's Change, or Settings -> Secrets).
func (o *Orchestrator) PutSecret(pid, name, value string) error {
	if err := o.secrets.Put(pid, name, value); err != nil {
		return err
	}
	o.hub.Publish(pid, events.SecretsChanged, map[string]any{"names": []string{name}})
	return nil
}

// DeleteSecret removes a secret.
func (o *Orchestrator) DeleteSecret(pid, name string) error {
	if err := o.secrets.Delete(pid, name); err != nil {
		return err
	}
	o.hub.Publish(pid, events.SecretsChanged, map[string]any{"names": []string{name}})
	return nil
}

const requestInputDescription = "Ask the user in a form: a secret (API key, password, token), text, an email, a date, " +
	"a number, a choice, a yes/no or a path. Pass schema (a flat JSON Schema object of primitive properties; a choice is " +
	"enum or oneOf, several choices an array of enum strings; x-octo.visible_when shows a field by an earlier one) or the " +
	"older fields, not both. Secrets (format password, kind secret) are stored by the harness and never shown to you: " +
	"use one as env {NAME: secret:<id>} on bash or spawn_agent. Other values come back in the result, typed."

const requestInputSchema = `{"type":"object","properties":{"title":{"type":"string"},"reason":{"type":"string"},` +
	`"schema":{"type":"object","description":"The form as a flat JSON Schema object (see the tool description)."},` +
	`"fields":{"type":"array","description":"Older form format; use schema instead.","items":{"type":"object","properties":{"id":{"type":"string"},"label":{"type":"string"},` +
	`"kind":{"type":"string","enum":["secret","text","select","confirm","path"]},"options":{"type":"array","items":{"type":"string"}},` +
	`"required":{"type":"boolean"},"help":{"type":"string"}},"required":["id","label","kind"]}}},"required":["title"]}`

// requestInputArgs is a request_input call.
type requestInputArgs struct {
	Title  string          `json:"title"`
	Reason string          `json:"reason"`
	Fields []inputs.Field  `json:"fields"`
	Schema json.RawMessage `json:"schema"`
}

// formOf validates a request_input call and returns its schema: the given
// one, or the legacy fields converted. The error is the tool error's text.
func formOf(in requestInputArgs) (inputs.Schema, error) {
	raw := bytes.TrimSpace(in.Schema)
	if len(raw) > 0 && raw[0] == '"' {
		// A schema sent as a JSON string holding the object.
		var s string
		if json.Unmarshal(raw, &s) == nil {
			raw = []byte(strings.TrimSpace(s))
		}
	}
	hasSchema := len(raw) > 0 && string(raw) != "null"
	if hasSchema == (in.Fields != nil) {
		return inputs.Schema{}, errors.New("Pass fields or schema, not both")
	}
	if !hasSchema {
		if err := inputs.Validate(in.Title, in.Fields); err != nil {
			return inputs.Schema{}, err
		}
		return inputs.FromFields(in.Fields), nil
	}
	if err := inputs.ValidateTitle(in.Title); err != nil {
		return inputs.Schema{}, err
	}
	return inputs.ParseSchema(raw, inputs.OriginTool)
}

// inputDef is the request_input tool of one agent.
func (rt *runtime) inputDef(a projectstore.Agent) tools.Def {
	return tools.Def{
		Name: ToolRequestInput, Description: requestInputDescription, InputSchema: json.RawMessage(requestInputSchema),
		Handle: func(ctx context.Context, raw json.RawMessage) (string, bool, error) {
			var in requestInputArgs
			if err := json.Unmarshal(raw, &in); err != nil {
				return "invalid request_input input: " + err.Error(), true, nil
			}
			in.Title, in.Reason = strings.TrimSpace(in.Title), strings.TrimSpace(in.Reason)
			schema, err := formOf(in)
			if err != nil {
				return err.Error(), true, nil
			}
			if len(in.Reason) > 400 {
				in.Reason = clip(in.Reason, 400)
			}
			rt.activity(a.ID, activity.WaitingApproval, "Waiting for your answer", "")
			res, err := rt.o.inputs.Request(ctx, rt.pid(), inputs.Input{
				AgentID: a.ID, SessionID: rt.sessionID, AgentLabel: agentLabel(a), TurnID: rt.turnID, Title: in.Title, Reason: in.Reason,
				Fields: in.Fields, Schema: schema, Source: &inputs.Source{Kind: "tool"},
			})
			rt.activity(a.ID, activity.Thinking, "Thinking", "")
			if err != nil {
				return "the request was cancelled", true, nil
			}
			return inputResult(res, schema), false, nil
		},
	}
}

// inputResult is the tool result the model sees: the answer's status, the
// non-secret values (typed), and for each secret only that it was provided and
// the name that uses it.
func inputResult(r inputs.Result, schema inputs.Schema) string {
	out := map[string]any{"status": r.Status}
	if r.Status == inputs.StatusSubmitted {
		out["values"] = r.Values
		provided, use := map[string]string{}, map[string]string{}
		for _, p := range schema.Properties {
			if _, ok := r.Secrets[p.ID]; ok && p.IsPassword() {
				provided[p.ID], use[p.ID] = "provided", secrets.Prefix+p.ID
			}
		}
		if len(provided) > 0 {
			out["secrets"], out["use_as"] = provided, use
		}
	}
	b, err := json.Marshal(out)
	if err != nil {
		return fmt.Sprintf(`{"status":%q}`, r.Status)
	}
	return string(b)
}

// bashEnvSchema adds the env property to bash's input schema.
func bashEnvSchema(raw json.RawMessage) json.RawMessage {
	var s map[string]any
	if json.Unmarshal(raw, &s) != nil {
		return raw
	}
	props, _ := s["properties"].(map[string]any)
	if props == nil {
		return raw
	}
	props["env"] = map[string]any{
		"type": "object", "additionalProperties": map[string]any{"type": "string"},
		"description": "Environment variables for this command, each NAME: \"secret:<name>\" naming a secret the user " +
			"stored through request_input. The harness fills the value in; you never see it.",
	}
	b, err := json.Marshal(s)
	if err != nil {
		return raw
	}
	return b
}
