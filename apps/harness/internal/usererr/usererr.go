// Package usererr is the one catalogue of everything the harness says to a
// person: a failure or a notice is an *Error with a plain one-sentence
// Message, a Hint (the next step in plain words), an optional Command to copy,
// an Action code the UI turns into a button, and Details (the technical text:
// protocol names, exit status, stderr line) that the UI keeps behind "Details".
//
// Every sentence the harness shows is built by a constructor in this package
// (catalogue_*.go). TestCatalogue pins their wording rules; TestNoAdHocStrings
// keeps new ad-hoc strings out of the packages that send errors to the UI.
// See apps/harness/docs/errors.md.
package usererr

import (
	"encoding/json"
	"errors"
	"strings"
)

// Action is a machine code the UI can turn into a button. None is "".
type Action string

const (
	ActionNone            Action = ""
	ActionRecheckProvider Action = "recheck_provider"
	ActionConnectProvider Action = "connect_provider"
	ActionRetry           Action = "retry"
	ActionOpenSettings    Action = "open_settings"
	ActionUpdateAgent     Action = "update_agent"
)

// Actions lists every code a client may receive (none is an absent field).
var Actions = []Action{ActionRecheckProvider, ActionConnectProvider, ActionRetry, ActionOpenSettings, ActionUpdateAgent}

// MaxDetails caps Details so a long stderr never floods a response.
const MaxDetails = 600

// Error is a failure or notice written for the person using the app.
type Error struct {
	// Code is the stable machine code of the case (the `code` of an HTTP error).
	Code string
	// Message is one plain sentence of what happened.
	Message string
	// Hint is the next step in plain words; "" when there is none.
	Hint string
	// Command is a copyable terminal command; "" when there is none.
	Command string
	// Action is the button the UI may offer.
	Action Action
	// Details is the technical text, shown only under "Details".
	Details string
	cause   error
}

func (e *Error) Error() string { return e.Message }
func (e *Error) Unwrap() error { return e.cause }

// Caused sets the underlying error (kept for errors.Is/As; its text becomes
// Details when none was given) and returns e.
func (e *Error) Caused(err error) *Error {
	e.cause = err
	if e.Details == "" && err != nil {
		e.Details = clip(err.Error())
	}
	return e
}

// WithDetails sets the technical text and returns e.
func (e *Error) WithDetails(s string) *Error {
	e.Details = clip(s)
	return e
}

// Fields is the structured form of e: message always, the rest only when set
// (an absent action means none).
func (e *Error) Fields() map[string]any {
	out := map[string]any{"message": e.Message}
	e.AddTo(out, "hint", "command", "action", "details")
	return out
}

// AddTo copies hint, command, action and details into m under the given keys,
// skipping empty ones.
func (e *Error) AddTo(m map[string]any, hint, command, action, details string) {
	if e.Hint != "" {
		m[hint] = e.Hint
	}
	if e.Command != "" {
		m[command] = e.Command
	}
	if e.Action != ActionNone {
		m[action] = string(e.Action)
	}
	if e.Details != "" {
		m[details] = e.Details
	}
}

// As returns the *Error in err's chain, or nil.
func As(err error) *Error {
	var u *Error
	if errors.As(err, &u) {
		return u
	}
	return nil
}

// Of is As with a fallback: an error that is not in the catalogue becomes
// Unexpected, its text kept as Details.
func Of(err error) *Error {
	if err == nil {
		return nil
	}
	if u := As(err); u != nil {
		return u
	}
	return Unexpected(err)
}

// Info is the JSON form of an Error where it sits beside other fields (a
// provider's `problem`): the same five keys the routes use.
type Info struct {
	Message string `json:"message"`
	Hint    string `json:"hint,omitempty"`
	Command string `json:"command,omitempty"`
	Action  Action `json:"action,omitempty"`
	Details string `json:"details,omitempty"`
}

// Info returns the JSON form of e (nil for nil).
func (e *Error) Info() *Info {
	if e == nil {
		return nil
	}
	return &Info{Message: e.Message, Hint: e.Hint, Command: e.Command, Action: e.Action, Details: e.Details}
}

// MarshalJSON writes the Info form, so an *Error can sit in a JSON struct.
func (e *Error) MarshalJSON() ([]byte, error) { return json.Marshal(e.Info()) }

func clip(s string) string {
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > MaxDetails {
		return string(r[:MaxDetails]) + "…"
	}
	return s
}
