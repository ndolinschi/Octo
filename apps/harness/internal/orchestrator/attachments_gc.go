package orchestrator

import (
	"context"
	"log/slog"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// AttachmentRetention is how long an uploaded image nothing refers to is kept.
const AttachmentRetention = 30 * 24 * time.Hour

// PruneAttachments removes, in every project, the attachments older than
// AttachmentRetention that no message and no queued message refers to.
func (o *Orchestrator) PruneAttachments(ctx context.Context) int {
	ids, err := o.store.IDs(ctx)
	if err != nil {
		if ctx.Err() == nil { // not the store closing at shutdown
			slog.Error("prune attachments: list projects", "err", err)
		}
		return 0
	}
	cutoff := projectstore.Stamp(o.now().Add(-AttachmentRetention))
	total := 0
	for _, id := range ids {
		db, err := o.store.Get(ctx, id)
		if err != nil {
			continue
		}
		n, err := db.PruneAttachments(ctx, cutoff)
		if err != nil {
			slog.Error("prune attachments", "project", id, "err", err)
		}
		total += n
	}
	return total
}

func (o *Orchestrator) pruneAttachmentsLoop(ctx context.Context) {
	o.PruneAttachments(ctx)
	t := time.NewTicker(24 * time.Hour)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			o.PruneAttachments(ctx)
		}
	}
}
