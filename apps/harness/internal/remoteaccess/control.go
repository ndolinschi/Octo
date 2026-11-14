package remoteaccess

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// ControlHandler is the computer's side: the /v1/remote routes, mounted on the main bridge behind its local API
// token. The tunnel listener refuses every one of them (rules.go).
func (m *Manager) ControlHandler() http.Handler {
	mux := http.NewServeMux()
	ok := func(w http.ResponseWriter, s Status) { writeJSON(w, http.StatusOK, s) }
	mux.HandleFunc("GET /v1/remote", func(w http.ResponseWriter, _ *http.Request) { ok(w, m.Status()) })
	mux.HandleFunc("POST /v1/remote/enable", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Acknowledge bool `json:"acknowledge"`
		}
		if err := decodeOptional(r, &body); err != nil {
			writeProblem(w, http.StatusBadRequest, usererr.Generic("invalid_request", err.Error()))
			return
		}
		s, err := m.Enable(body.Acknowledge)
		if err != nil {
			refuse(w, err)
			return
		}
		ok(w, s)
	})
	mux.HandleFunc("POST /v1/remote/disable", func(w http.ResponseWriter, _ *http.Request) { ok(w, m.Disable()) })
	mux.HandleFunc("POST /v1/remote/check", func(w http.ResponseWriter, _ *http.Request) { ok(w, m.Check()) })
	mux.HandleFunc("POST /v1/remote/pairing", func(w http.ResponseWriter, _ *http.Request) {
		s, err := m.IssueCode()
		if err != nil {
			refuse(w, err)
			return
		}
		ok(w, s)
	})
	mux.HandleFunc("DELETE /v1/remote/pairing", func(w http.ResponseWriter, _ *http.Request) { ok(w, m.CancelCode()) })
	mux.HandleFunc("POST /v1/remote/devices/{id}/confirm", func(w http.ResponseWriter, r *http.Request) {
		if err := m.Confirm(r.PathValue("id")); err != nil {
			refuse(w, err)
			return
		}
		ok(w, m.Status())
	})
	mux.HandleFunc("PATCH /v1/remote/devices/{id}", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			ReadOnly *bool `json:"read_only"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil || body.ReadOnly == nil {
			writeProblem(w, http.StatusBadRequest, usererr.Generic("invalid_request", "body must be {read_only: bool}"))
			return
		}
		if err := m.SetReadOnly(r.PathValue("id"), *body.ReadOnly); err != nil {
			refuse(w, err)
			return
		}
		ok(w, m.Status())
	})
	mux.HandleFunc("DELETE /v1/remote/devices/{id}", func(w http.ResponseWriter, r *http.Request) {
		if err := m.Revoke(r.PathValue("id")); err != nil {
			refuse(w, err)
			return
		}
		ok(w, m.Status())
	})
	mux.HandleFunc("POST /v1/remote/revoke-all", func(w http.ResponseWriter, _ *http.Request) {
		s, err := m.RevokeAllAndOff()
		if err != nil {
			refuse(w, err)
			return
		}
		ok(w, s)
	})
	mux.HandleFunc("/v1/remote/", func(w http.ResponseWriter, _ *http.Request) {
		writeProblem(w, http.StatusNotFound, usererr.Generic("not_found", "no such route"))
	})
	return mux
}

func decodeOptional(r *http.Request, v any) error {
	err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(v)
	if errors.Is(err, io.EOF) {
		return nil
	}
	return err
}

func refuse(w http.ResponseWriter, err error) {
	if errors.Is(err, ErrNoDevice) {
		writeProblem(w, http.StatusNotFound, usererr.Generic("not_found", err.Error()))
		return
	}
	if u := usererr.As(err); u != nil {
		writeProblem(w, http.StatusConflict, u)
		return
	}
	writeProblem(w, http.StatusInternalServerError, usererr.Generic("internal", err.Error()))
}
