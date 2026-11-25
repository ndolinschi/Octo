package bridge

import (
	"errors"
	"net/http"

	"github.com/ndolinschi/Octo/apps/harness/internal/completion"
)

// complete answers one inline-completion request. 204 means nothing to
// suggest (or the file is on the never-sent list: X-Completion-Skipped says why).
// The request context is the cancellation: an aborted client aborts the model call.
func (s *Server) complete(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Folder   string               `json:"folder"`
		Path     string               `json:"path"`
		Language string               `json:"language"`
		Prefix   string               `json:"prefix"`
		Suffix   string               `json:"suffix"`
		MaxLines int                  `json:"max_lines"`
		Snippets []completion.Snippet `json:"snippets"`
	}
	if !decode(w, r, &in) {
		return
	}
	res, skipped, err := s.svc.Complete(r.Context(), r.PathValue("pid"), completion.Request{
		Folder: in.Folder, Path: in.Path, Language: in.Language, Prefix: in.Prefix, Suffix: in.Suffix,
		MaxLines: in.MaxLines, Snippets: in.Snippets,
	})
	if err != nil {
		if r.Context().Err() != nil || errors.Is(err, r.Context().Err()) {
			w.WriteHeader(http.StatusNoContent) // the client went away
			return
		}
		writeErr(w, err)
		return
	}
	if skipped != "" {
		w.Header().Set("X-Completion-Skipped", skipped)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if res.Text == "" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"text": res.Text, "model": res.Model, "ms": res.MS})
}
