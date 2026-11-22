package bridge

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Debug("write response", "err", err)
	}
}

// errorBody is the body every error carries: code, a plain one-sentence
// message, and when there is one a hint, a command, an action code and the
// technical details (see apps/harness/docs/errors.md).
func errorBody(code string, u *usererr.Error) map[string]any {
	body := map[string]any{"code": code, "message": u.Message}
	u.AddTo(body, "hint", "command", "action", "details")
	return body
}

// writeProblem sends a catalogue error under the case's own code.
func writeProblem(w http.ResponseWriter, status int, u *usererr.Error) {
	writeJSON(w, status, map[string]any{"error": errorBody(u.Code, u)})
}

// writeError sends a route's own error. msg is technical text for the client's
// developer, not for a person: the body carries the catalogue's plain wording
// for code (usererr.Generic) and msg as `details`. Failures a person can act
// on are catalogue cases sent with writeProblem.
func writeError(w http.ResponseWriter, status int, code, msg string) {
	writeProblem(w, status, usererr.Generic(code, msg))
}

// writeErr maps service errors to the API's 400 / 404 / 409 / 413 / 415 / 500 shape.
func writeErr(w http.ResponseWriter, err error) {
	var pe *project.Error
	if errors.As(err, &pe) {
		status := map[project.Kind]int{
			project.KindInvalid:       http.StatusBadRequest,
			project.KindNotFound:      http.StatusNotFound,
			project.KindConflict:      http.StatusConflict,
			project.KindTooLarge:      http.StatusRequestEntityTooLarge,
			project.KindUnsupported:   http.StatusUnsupportedMediaType,
			project.KindUpstream:      http.StatusBadGateway,
			project.KindUnprocessable: http.StatusUnprocessableEntity,
		}[pe.Kind]
		if status == 0 {
			status = http.StatusInternalServerError
		}
		body := errorBody(pe.Code, pe.Catalogue())
		if pe.Code == "model_unavailable" {
			body["provider"], body["reason"], body["can_force"] = pe.Provider, pe.Reason, pe.CanForce
		}
		if pe.Details != nil {
			// rewind_conflict: the report of the files, which stays machine data.
			body["details"] = pe.Details
		}
		if pe.Fields != nil {
			// A refused form answer: a message by property id, never a value.
			body["fields"] = pe.Fields
		}
		writeJSON(w, status, map[string]any{"error": body})
		return
	}
	if u := usererr.As(err); u != nil {
		writeProblem(w, http.StatusConflict, u)
		return
	}
	slog.Error("request failed", "err", err)
	writeError(w, http.StatusInternalServerError, "internal", "internal error")
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody))
	if err := dec.Decode(v); err != nil {
		// P2-6: a body over the limit (a pasted log in a message) is 413 with the limit, not "not valid".
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeProblem(w, http.StatusRequestEntityTooLarge, usererr.RequestTooLarge(tooBig.Limit))
			return false
		}
		writeError(w, http.StatusBadRequest, "invalid_request", "invalid JSON body: "+err.Error())
		return false
	}
	return true
}
