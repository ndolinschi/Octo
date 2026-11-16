import { MousePointerClick, X } from "lucide-react";
import { useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { browserHostLabel, elementSummary } from "../../lib/browser/designNotes";
import { clearStagedDesignNotes, removeStagedDesignNote, useStagedDesignNotes } from "../../state/designNotes";
import { useProject } from "../../state/project";
import { Button } from "../primitives/Button";
import { IconButton } from "../primitives/IconButton";
import { Popover } from "../primitives/Popover";
import { Presence } from "../primitives/Presence";
import { PILL } from "./ComposerPills";

/**
 * "N design notes": staged Browser Design Mode annotations queued for the next message in the composer.
 * Opens a compact popover listing each staged element/area note with individual remove and "Remove all".
 */
export function DesignNotesControl(props: { open?: boolean | undefined; onOpenChange?: ((open: boolean) => void) | undefined }) {
  const { projectId } = useProject();
  const notes = useStagedDesignNotes(projectId);
  const [ownOpen, setOwnOpen] = useState(false);
  const open = props.open ?? ownOpen;
  const setOpen = (next: boolean | ((x: boolean) => boolean)) => {
    const value = typeof next === "function" ? next(open) : next;
    setOwnOpen(value);
    props.onOpenChange?.(value);
  };
  const anchor = useRef<HTMLButtonElement>(null);
  const n = notes.length;
  if (!n) return null;
  const label = `${n}\u00a0design ${n === 1 ? "note" : "notes"}`;
  return (
    <>
      <Button
        ref={anchor}
        size="sm"
        variant="quiet"
        icon={MousePointerClick}
        data-design-notes-pill
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${n} design ${n === 1 ? "note" : "notes"}`}
        title="Pending design notes, sent with your next message"
        onClick={() => setOpen((x) => !x)}
        className={cn(PILL, "pr-2 tabular-nums hover:bg-active hover:text-fg", open ? "bg-active text-fg" : "text-fg")}
      >
        {label}
      </Button>
      <Presence show={open}>
        <Popover anchor={anchor} label="Pending design notes" side="top" gap={4} onClose={() => setOpen(false)} className="w-[min(380px,calc(100vw-16px))]">
          <p className="flex h-row shrink-0 items-center px-4 pt-1 text-xs text-fg-3">Sent with your next message</p>
          <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto overscroll-contain p-1.5">
            {notes.map((note) => {
              const target =
                note.elements.length > 0
                  ? note.elements.map(elementSummary).join(", ")
                  : note.area
                    ? `Area ${Math.round(note.area.width)}×${Math.round(note.area.height)}`
                    : browserHostLabel(note.url);
              const cssCount = note.cssEdits?.length ?? 0;
              const detail =
                note.text.split("\n", 1)[0] ||
                (cssCount > 0 ? `${cssCount} CSS ${cssCount === 1 ? "edit" : "edits"}` : "") ||
                (note.textEdit ? `"${note.textEdit.before}" → "${note.textEdit.after}"` : "Annotated selection");
              return (
                <li key={note.id} className="flex min-h-8 items-center gap-2 rounded-sm px-2 py-1 hover:bg-hover">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-xs text-fg">{target}</div>
                    <div className="truncate text-xs text-fg-2">{detail}</div>
                  </div>
                  <IconButton icon={X} size="xs" label={`Remove design note on ${target}`} onClick={() => removeStagedDesignNote(projectId, note.id)} />
                </li>
              );
            })}
          </ul>
          <div className="flex h-bar shrink-0 items-center justify-end border-t border-line px-2">
            <Button
              size="xs"
              variant="quiet"
              onClick={() => {
                clearStagedDesignNotes(projectId);
                setOpen(false);
              }}
            >
              Remove all
            </Button>
          </div>
        </Popover>
      </Presence>
    </>
  );
}
