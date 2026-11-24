package bridge

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
)

const maxFileBody = 3 << 20

func (s *Server) listFiles(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	entries, err := s.files.ListInWorkspace(r.Context(), r.PathValue("pid"), q.Get("folder"), q.Get("path"), q.Get("workspace"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": entries})
}

func (s *Server) searchFiles(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit := 50
	if raw := q.Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 200 {
			writeError(w, http.StatusBadRequest, "invalid_request", "limit must be an integer from 1 to 200")
			return
		}
		limit = n
	}
	matches, err := s.files.SearchInWorkspace(r.Context(), r.PathValue("pid"), q.Get("q"), q.Get("mode"), q.Get("workspace"), limit)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"matches": matches})
}

func (s *Server) readFile(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	ws := q.Get("workspace")
	switch q.Get("encoding") {
	case "", "utf-8":
	case "base64":
		fb, err := s.files.ReadBytesInWorkspace(r.Context(), r.PathValue("pid"), q.Get("folder"), q.Get("path"), ws)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, fb)
		return
	default:
		writeError(w, http.StatusBadRequest, "invalid_request", "encoding must be base64 or omitted")
		return
	}
	fc, err := s.files.ReadInWorkspace(r.Context(), r.PathValue("pid"), q.Get("folder"), q.Get("path"), ws)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, fc)
}

func (s *Server) writeFile(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Folder        string  `json:"folder"`
		Path          string  `json:"path"`
		Content       string  `json:"content"`
		ExpectedMTime *string `json:"expected_mtime"`
		WorkspaceID   string  `json:"workspace_id"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxFileBody)).Decode(&in); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeError(w, http.StatusRequestEntityTooLarge, "file_too_large", "request body exceeds the 3 MiB limit")
			return
		}
		writeError(w, http.StatusBadRequest, "invalid_request", "invalid JSON body: "+err.Error())
		return
	}
	st, err := s.files.WriteInWorkspace(r.Context(), r.PathValue("pid"), in.Folder, in.Path, in.Content, in.ExpectedMTime, in.WorkspaceID)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) mkdirFile(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Folder      string `json:"folder"`
		Path        string `json:"path"`
		WorkspaceID string `json:"workspace_id"`
	}
	if !decode(w, r, &in) {
		return
	}
	clean, err := s.files.MkdirInWorkspace(r.Context(), r.PathValue("pid"), in.Folder, in.Path, in.WorkspaceID)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"folder": in.Folder, "path": clean})
}

func (s *Server) renameFile(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Folder      string `json:"folder"`
		From        string `json:"from"`
		To          string `json:"to"`
		WorkspaceID string `json:"workspace_id"`
	}
	if !decode(w, r, &in) {
		return
	}
	clean, err := s.files.RenameInWorkspace(r.Context(), r.PathValue("pid"), in.Folder, in.From, in.To, in.WorkspaceID)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"folder": in.Folder, "path": clean})
}

func (s *Server) deleteFileEntry(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if err := s.files.DeleteInWorkspace(r.Context(), r.PathValue("pid"), q.Get("folder"), q.Get("path"), q.Get("workspace")); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
