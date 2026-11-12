import type { Note } from "@octo/agent-client";
import { Pencil, Pin, PinOff } from "lucide-react";
import { useState } from "react";
import { formatRelative } from "../../lib/format";
import { Button } from "../primitives/Button";
import { IconButton } from "../primitives/IconButton";
import { IconMenu } from "../primitives/IconMenu";
import { Notice } from "../primitives/Notice";
import { SkeletonText } from "../primitives/Skeleton";
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
  return (
    <article className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-4 py-4" aria-label={note.title}>
      <header className="flex flex-col gap-1">
        <div className="flex min-h-7 items-center gap-2">
          <h2 className="min-w-0 flex-1 text-title [overflow-wrap:anywhere] text-fg">{note.title}</h2>
          <IconButton icon={Pencil} label={`Edit ${note.title}`} onClick={props.onEdit} />
          <IconButton icon={note.pinned ? PinOff : Pin} label={note.pinned ? "Unpin" : "Pin"} pressed={note.pinned} onClick={() => void props.onTogglePin()} />
          <IconMenu
            label="More"
            items={[
              { id: "export", label: "Export as .md", disabled: load.status !== "ok", run: () => load.status === "ok" && props.onExport(load.doc.markdown) },
              { id: "delete", label: "Delete…", run: () => setConfirming(true) },
            ]}
          />
        </div>
        <p className="flex flex-wrap gap-x-3 text-xs text-fg-3">
          <span>{note.author === "orchestrator" ? "Orchestrator" : "You"}</span>
          <time dateTime={note.updated_at} className="tabular-nums">
            Updated {formatRelative(note.updated_at, props.now)}
          </time>
          {note.read_count > 0 && <span className="tabular-nums">Opened by agents {note.read_count}×</span>}
        </p>
      </header>
      {props.pinError && <Notice tone="error">{props.pinError}</Notice>}
      {confirming && (
        <div role="alertdialog" aria-label={`Delete ${note.title}`} className="flex flex-wrap items-center gap-2 text-sm">
          <span className="min-w-0 flex-1 text-fg-2">
            Delete <span className="text-fg">{note.title}</span>?
          </span>
          <Button size="sm" variant="quiet" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button size="sm" variant="danger" onClick={() => void props.onDelete()} autoFocus>
            Delete note
          </Button>
        </div>
      )}
      <section aria-label="What agents see" className="flex flex-col gap-1">
        <p className="text-xs text-fg-3">What agents see</p>
        <p className="text-sm text-fg">{note.description || "No description."}</p>
        {note.description_auto && <p className="text-xs text-fg-3">Taken from the first line. Edit the note and write one so agents know when to open it.</p>}
        {note.tags.length > 0 && <p className="text-xs text-fg-3">{note.tags.map((t) => `#${t}`).join(" ")}</p>}
      </section>
      <section aria-label="Note" className="flex flex-col gap-1">
        {load.status === "loading" && <SkeletonText lines={4} />}
        {load.status === "error" && (
          <Notice tone="error" className="text-sm">
            Couldn't open the note: {load.message}. Select it again to retry.
          </Notice>
        )}
        {load.status === "ok" &&
          (load.doc.content.trim() ? (
            <Markdown text={load.doc.content} className="octo-prose octo-prose-sm" />
          ) : (
            <p className="text-sm text-fg-3">This note has no body.</p>
          ))}
      </section>
    </article>
  );
}
