package usererr

import (
	"fmt"
	"strings"
)

// The cases below are the validation failures a person can cause from the UI.
// Generic reaches them through specific, matching the route's technical
// sentence (which stays as Details), so every route that says
// "models.x: ..." or "project not found" gets the same plain wording.

// InvalidModelSetting: a model setting holds a value the harness cannot use.
func InvalidModelSetting() *Error {
	return &Error{Code: "invalid_request", Message: "That model setting is not valid.", Hint: "Pick a model from the list, or leave the setting empty.", Action: ActionOpenSettings}
}

// NotFoundWhat: the project, folder, session or other item a request names
// does not exist (any more).
func NotFoundWhat(what string) *Error {
	return &Error{Code: "not_found", Message: fmt.Sprintf("That %s no longer exists.", what), Hint: "Refresh the list, then try again.", Action: ActionRetry}
}

// NameTooLong: a name has more characters than the app keeps.
func NameTooLong(max int) *Error {
	return &Error{Code: "invalid_request", Message: "That name is too long.", Hint: fmt.Sprintf("Use at most %d characters.", max)}
}

// BudgetInvalid: a budget that is not a positive number.
func BudgetInvalid() *Error {
	return &Error{Code: "invalid_request", Message: "A budget has to be a number above zero.", Hint: "Type an amount in dollars, or clear the field to remove the budget."}
}

// ModeUnknown: a mode that is not one of the choices.
func ModeUnknown() *Error {
	return &Error{Code: "invalid_request", Message: "That mode is not one of the choices.", Hint: "Pick a mode from the list."}
}

// TitleTaken: a note already has the title.
func TitleTaken() *Error {
	return &Error{Code: "invalid_request", Message: "A note with that title exists already.", Hint: "Open it to change it, or choose another title."}
}

// CommandNameTaken: a command with the name exists.
func CommandNameTaken() *Error {
	return &Error{Code: "invalid_request", Message: "A command with that name exists already.", Hint: "Choose another name, or change the existing command."}
}

// BranchMissing: the branch or base a request names is not in the repository.
func BranchMissing() *Error {
	return &Error{Code: "unknown_ref", Message: "That branch does not exist in the repository.", Hint: "Pick a branch from the list, or fetch to see newer ones."}
}

var notFoundWhats = map[string]bool{
	"project": true, "folder": true, "session": true, "agent": true, "note": true, "change": true, "plan": true,
	"approval": true, "form": true, "secret": true, "fact": true, "review": true, "comment": true, "file": true, "path": true,
}

// specific returns the plain case for a route's technical sentence, or nil.
func specific(code, technical string) *Error {
	t := strings.ToLower(technical)
	var e *Error
	switch code {
	case "invalid_request":
		switch {
		case strings.HasPrefix(t, "models."):
			e = InvalidModelSetting()
		case strings.Contains(t, "budget"):
			e = BudgetInvalid()
		case strings.HasPrefix(t, "mode must be"):
			e = ModeUnknown()
		case strings.HasPrefix(t, "name is required"), strings.HasPrefix(t, "name must not be empty"), strings.HasPrefix(t, "title must not be empty"):
			e = NameRequired()
		case strings.Contains(t, "name is too long"), strings.HasPrefix(t, "title is at most"):
			e = NameTooLong(200)
		case strings.HasPrefix(t, "a note titled"):
			e = TitleTaken()
		case strings.Contains(t, "command") && strings.Contains(t, "exists"):
			e = CommandNameTaken()
		}
	case "not_found":
		if what, ok := strings.CutSuffix(t, " not found"); ok && notFoundWhats[strings.TrimSpace(what)] {
			e = NotFoundWhat(strings.TrimSpace(what))
		}
	case "unknown_ref":
		e = BranchMissing()
	}
	if e != nil {
		e.Code = code
		e.Details = clip(technical)
	}
	return e
}
