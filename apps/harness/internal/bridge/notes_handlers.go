package bridge

import (
	"io"
	"net/http"
	"strings"
	"unicode"

	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// Notes are Markdown documents (docs/memory.md, M5): the list returns the
// front-matter fields without bodies, get returns one note with its body and
// Markdown source, create and update take either the fields or raw Markdown
// with front matter (a parse error is a 400 naming the line).

// noteJSON is a note with its Markdown source (the get, create and update responses).
type noteJSON struct {
	projectstore.Note
	Markdown string `json:"markdown"`
}

func withMarkdown(n projectstore.Note) noteJSON {
	return noteJSON{Note: n, Markdown: project.Markdown(n)}
}

func (s *Server) getNote(w http.ResponseWriter, r *http.Request) {
	n, err := s.notes.Get(r.Context(), r.PathValue("pid"), r.PathValue("nid"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, withMarkdown(n))
}

// exportNote serves a note as a .md file (front matter and body).
func (s *Server) exportNote(w http.ResponseWriter, r *http.Request) {
	n, err := s.notes.Get(r.Context(), r.PathValue("pid"), r.PathValue("nid"))
	if err != nil {
		writeErr(w, err)
		return
	}
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+noteFileName(n.Title)+`"`)
	_, _ = io.WriteString(w, project.Markdown(n))
}

// noteFileName is a safe file name for a note title.
func noteFileName(title string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(strings.TrimSpace(title)) {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			b.WriteRune(r)
		case b.Len() > 0 && !strings.HasSuffix(b.String(), "-"):
			b.WriteByte('-')
		}
	}
	name := strings.Trim(b.String(), "-")
	if name == "" {
		name = "note"
	}
	return name + ".md"
}

func (s *Server) createNote(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Title       string   `json:"title"`
		Content     string   `json:"content"`
		Description string   `json:"description"`
		Tags        []string `json:"tags"`
		Pinned      bool     `json:"pinned"`
		Markdown    string   `json:"markdown"`
	}
	if !decode(w, r, &in) {
		return
	}
	n, err := s.notes.CreateNote(r.Context(), r.PathValue("pid"), project.NoteInput{
		Title: in.Title, Description: in.Description, Tags: in.Tags, Pinned: in.Pinned, Content: in.Content, Markdown: in.Markdown})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, withMarkdown(n))
}

func (s *Server) updateNote(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Title       *string   `json:"title"`
		Content     *string   `json:"content"`
		Description *string   `json:"description"`
		Tags        *[]string `json:"tags"`
		Pinned      *bool     `json:"pinned"`
		Markdown    *string   `json:"markdown"`
	}
	if !decode(w, r, &in) {
		return
	}
	n, err := s.notes.Patch(r.Context(), r.PathValue("pid"), r.PathValue("nid"), project.NotePatch{
		Title: in.Title, Description: in.Description, Tags: in.Tags, Pinned: in.Pinned, Content: in.Content, Markdown: in.Markdown})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, withMarkdown(n))
}
