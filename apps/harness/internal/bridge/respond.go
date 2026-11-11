package bridge

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/ndolinschi/Octo/apps/harness/internal/project"
)

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Debug("write response", "err", err)
	}
}

func writeError(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": msg}})
}

// writeErr maps service errors to the API's 400 / 404 / 409 / 413 / 415 / 500 shape.
func writeErr(w http.ResponseWriter, err error) {
	var pe *project.Error
	if errors.As(err, &pe) {
		status := map[project.Kind]int{
			project.KindInvalid:     http.StatusBadRequest,
			project.KindNotFound:    http.StatusNotFound,
			project.KindConflict:    http.StatusConflict,
			project.KindTooLarge:    http.StatusRequestEntityTooLarge,
			project.KindUnsupported: http.StatusUnsupportedMediaType,
			project.KindUpstream:    http.StatusBadGateway,
		}[pe.Kind]
		writeError(w, status, pe.Code, pe.Message)
		return
	}
	slog.Error("request failed", "err", err)
	writeError(w, http.StatusInternalServerError, "internal", "internal error")
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody))
	if err := dec.Decode(v); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "invalid JSON body: "+err.Error())
		return false
	}
	return true
}
