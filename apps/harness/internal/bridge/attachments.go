package bridge

import (
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"path"
	"strconv"

	"github.com/ndolinschi/Octo/apps/harness/internal/attachments"
)

// uploadSlack is room for the multipart framing around a 5 MB image.
const uploadSlack = 1 << 20

// uploadAttachment stores one image: a multipart body with a "file" part, or the
// raw bytes with any Content-Type (the file name may come as ?name=). The type
// is decided from the content, not from the header.
func (s *Server) uploadAttachment(w http.ResponseWriter, r *http.Request) {
	body := http.MaxBytesReader(w, r.Body, attachments.MaxBytes+uploadSlack)
	var file io.Reader = body
	name := r.URL.Query().Get("name")
	if mt, params, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err == nil && mt == "multipart/form-data" {
		mr := multipart.NewReader(body, params["boundary"])
		var part *multipart.Part
		for {
			p, err := mr.NextPart()
			if err != nil {
				writeError(w, http.StatusBadRequest, "invalid_request", "multipart body without a \"file\" part")
				return
			}
			if p.FormName() == "file" {
				part = p
				break
			}
		}
		file = part
		if part.FileName() != "" {
			name = part.FileName()
		}
	}
	a, err := s.svc.UploadAttachment(r.Context(), r.PathValue("pid"), path.Base(name), file)
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeError(w, http.StatusRequestEntityTooLarge, "attachment_too_large", "the image is larger than 5 MB; downsize it before uploading")
			return
		}
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, a)
}

func (s *Server) getAttachment(w http.ResponseWriter, r *http.Request) {
	a, data, err := s.svc.Attachment(r.Context(), r.PathValue("pid"), r.PathValue("id"))
	if err != nil {
		writeErr(w, err)
		return
	}
	w.Header().Set("Content-Type", a.MediaType)
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	_, _ = w.Write(data)
}
