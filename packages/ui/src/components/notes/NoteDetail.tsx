import type { Note } from "@octo/agent-client";
import { Pencil, Pin } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/cn";
import { formatRelative } from "../../lib/format";
import { DETAIL_COLUMN } from "../../lib/panelColumn";
import { Button } from "../primitives/Button";
import { IconMenu } from "../primitives/IconMenu";
import { Notice } from "../primitives/Notice";
import { DetailHeader, FormActions } from "../primitives/Panel";
import { proseClass } from "../primitives/Prose";
import { SkeletonText } from "../primitives/SkeletonText";
import { Markdown } from "../shared/Markdown";
import type { DocLoad } from "./useNoteDoc";

/** One note, read: title, what agents see, the rendered body. Edit, pin, export and delete are here, not on the list. */
export function NoteDetail(props: {
  note: Note;
  load: DocLoad;
  now: number;
  onEdit(): void;
  onTogglePin(): Promise<void>;
  onExport(markdown: string): void;
  onDelete(): Promise<void>;
  pinError: string | null;
}) {
  const { note, load } = props;
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  return (
    <article className={cn("flex flex-col gap-4", DETAIL_COLUMN)} aria-label={note.title}>
      <DetailHeader
        title={note.title}
        meta={[
          note.author === "orchestrator" ? "Octo" : "You",
          `Updated ${formatRelative(note.updated_at, props.now)}`,
          note.read_count > 0 ? `Opened by agents ${note.read_count}×` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        actions={
          <>
            {/* P2 (B34): labelled quiet buttons, as Memory's file detail — Edit first, then the pin, the "⋯" last. A pinned note
                says "Pinned" (pressed); pressing it unpins. */}
            <Button variant="quiet" size="sm" icon={Pencil} aria-label={`Edit ${note.title}`} disabled={load.status !== "ok"} onClick={props.onEdit}>
              Edit
            </Button>
            <Button
              variant="quiet"
              size="sm"
              icon={Pin}
              pressed={note.pinned}
              title={note.pinned ? "Pinned: agents always get the full note. Press to unpin." : "Pin: agents always get the full note"}
              onClick={() => void props.onTogglePin()}
            >
              {note.pinned ? "Pinned" : "Pin"}
            </Button>
            <IconMenu
              label="More"
              items={[
                { id: "export", label: "Export as .md", disabled: load.status !== "ok", run: () => load.status === "ok" && props.onExport(load.doc.markdown) },
                { id: "delete", label: "Delete…", run: () => setConfirming(true) },
              ]}
            />
          </>
        }
      />
      {props.pinError && (
        <Notice tone="error" className="px-2">
          {props.pinError}
        </Notice>
      )}
      {deleteError && (
        <Notice tone="error" className="px-2">
          {deleteError}
        </Notice>
      )}
      {confirming && (
        <FormActions
          note={
            <>
              Delete <span className="text-fg">{note.title}</span>?
            </>
          }
          label={`Delete ${note.title}`}
          className="px-2"
        >
          <Button size="sm" variant="quiet" disabled={deleting} onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="danger"
            loading={deleting}
            onClick={() => {
              setDeleting(true);
              setDeleteError(null);
              void props
                .onDelete()
                .catch((e: unknown) => setDeleteError(e instanceof Error ? e.message : "Could not delete the note."))
                .finally(() => setDeleting(false));
            }}
            autoFocus
          >
            Delete note
          </Button>
        </FormActions>
      )}
      <section aria-label="What agents see" className="flex flex-col gap-1 px-2">
        <p className="text-xs text-fg-3">What agents see</p>
        <p className="text-sm text-fg">{note.description || "No description."}</p>
        {note.description_auto && <p className="text-xs text-fg-3">Taken from the first line. Edit the note and write one so agents know when to open it.</p>}
        {note.tags.length > 0 && <p className="text-xs text-fg-3">{note.tags.map((t) => `#${t}`).join(" ")}</p>}
      </section>
      <section aria-label="Note" className="flex flex-col gap-1 px-2">
        {load.status === "loading" && <SkeletonText lines={4} />}
        {load.status === "error" && (
          <Notice tone="error" className="text-sm">
            Couldn't open the note: {load.message}. Select it again to retry.
          </Notice>
        )}
        {load.status === "ok" &&
          (load.doc.content.trim() ? (
            <Markdown text={load.doc.content} className={proseClass("compact")} />
          ) : (
            <p className="text-sm text-fg-3">This note has no body.</p>
          ))}
      </section>
    </article>
  );
}
