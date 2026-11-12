package project

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/attachments"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// defaultImageText is the text of a message that has images and no words.
const defaultImageText = "Look at the attached image(s)."

// UploadAttachment stores one image. The type is decided by sniffing the
// content; the declared type and the file name are not trusted. 413
// attachment_too_large above 5 MB, 415 unsupported_media_type for anything
// that is not a PNG, JPEG, WebP or GIF.
func (s *Service) UploadAttachment(ctx context.Context, pid, name string, r io.Reader) (projectstore.Attachment, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return projectstore.Attachment{}, err
	}
	data, err := io.ReadAll(io.LimitReader(r, attachments.MaxBytes+1))
	if err != nil {
		return projectstore.Attachment{}, err
	}
	info, err := attachments.Describe(data)
	switch {
	case errors.Is(err, attachments.ErrTooLarge):
		return projectstore.Attachment{}, &Error{Kind: KindTooLarge, Code: "attachment_too_large",
			Message: "the image is larger than 5 MB"}
	case errors.Is(err, attachments.ErrEmpty):
		return projectstore.Attachment{}, invalid("the upload is empty")
	case err != nil:
		return projectstore.Attachment{}, &Error{Kind: KindUnsupported, Code: "unsupported_media_type",
			Message: "only PNG, JPEG, WebP and GIF images can be attached"}
	}
	name = strings.TrimSpace(name)
	if len(name) > 200 {
		name = name[:200]
	}
	return db.PutAttachment(ctx, info, name, data)
}

// Attachment returns an attachment's record and bytes.
func (s *Service) Attachment(ctx context.Context, pid, id string) (projectstore.Attachment, []byte, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return projectstore.Attachment{}, nil, err
	}
	if !attachments.ValidID(id) {
		return projectstore.Attachment{}, nil, notFound("attachment")
	}
	a, data, err := db.AttachmentData(ctx, id)
	if errors.Is(err, projectstore.ErrNotFound) {
		return a, nil, notFound("attachment")
	}
	return a, data, err
}

// checkAttachments validates the ids a message names (at most 8, each stored)
// and, for a project whose agent cannot take images, refuses with 422
// images_unsupported before anything is sent.
func (s *Service) checkAttachments(ctx context.Context, db *projectstore.DB, pid string, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	if len(ids) > attachments.MaxPerMessage {
		return invalid("at most %d images per message", attachments.MaxPerMessage)
	}
	seen := map[string]bool{}
	for _, id := range ids {
		if seen[id] {
			return invalid("attachment %s is listed twice", id)
		}
		seen[id] = true
		if !attachments.ValidID(id) {
			return invalid("attachments: %q is not an attachment id", id)
		}
		if _, err := db.Attachment(ctx, id); err != nil {
			if errors.Is(err, projectstore.ErrNotFound) {
				return &Error{Kind: KindNotFound, Code: "attachment_not_found", Message: fmt.Sprintf("attachment %s not found; upload it again", id)}
			}
			return err
		}
	}
	ok, known, label, err := s.turns.ImagesAccepted(ctx, pid, true)
	if err != nil {
		return err
	}
	if known && !ok {
		return imagesUnsupported(label)
	}
	return nil
}

func imagesUnsupported(label string) *Error {
	return of(KindUnprocessable, usererr.ImagesUnsupported(label))
}

// PostMessageWith is PostMessage with the ids of uploaded images attached to
// the message (in order). A message with images and no text gets a one-line
// default text.
func (s *Service) PostMessageWith(ctx context.Context, pid, text string, mode *string, attach []string) (msg projectstore.Message, queued *projectstore.QueuedMessage, err error) {
	if len(attach) == 0 {
		return s.PostMessage(ctx, pid, text, mode)
	}
	if strings.TrimSpace(text) == "" {
		text = defaultImageText
	}
	if err := validMode(mode); err != nil {
		return msg, nil, err
	}
	db, err := s.db(ctx, pid)
	if err != nil {
		return msg, nil, err
	}
	if err := s.checkAttachments(ctx, db, pid, attach); err != nil {
		return msg, nil, err
	}
	m := ""
	if mode != nil {
		m = *mode
	}
	msg, queued, err = s.turns.SubmitAttach(ctx, pid, text, m, attach)
	switch {
	case errors.Is(err, orchestrator.ErrQueueFull):
		return msg, nil, queueFull()
	case errors.Is(err, orchestrator.ErrTurnInProgress):
		return msg, nil, turnInProgress()
	case errors.Is(err, projectstore.ErrNotFound):
		return msg, nil, notFound("project")
	}
	return msg, queued, storeErr(err)
}
