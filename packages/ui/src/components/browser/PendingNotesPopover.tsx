import { Layers, X } from "lucide-react";
import { useRef, useState } from "react";
import { elementSummary, type DesignNote } from "../../lib/browser/designNotes";
import { Button } from "../primitives/Button";
import { IconButton } from "../primitives/IconButton";
import { Popover } from "../primitives/Popover";
import { Presence } from "../primitives/Presence";

/**
 * Toolbar button + popover listing pending batch notes on the current Browser tab.
 */
export function PendingNotesPopover(props: {
  notes: readonly DesignNote[];
  onSelect(note: DesignNote): void;
  onRemove(noteId: string): void;
  onClearAll(): void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const n = props.notes.length;
  if (n === 0) return null;

  return (
    <>
      <Button
        ref={anchor}
        variant="secondary"
        size="sm"
        icon={Layers}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-pending-notes-trigger
        onClick={() => setOpen((v) => !v)}
      >
        {`${n} ${n === 1 ? "pin" : "pins"}`}
      </Button>
      <Presence show={open}>
        <Popover
          anchor={anchor}
          label="Pending design pins"
          side="bottom"
          align="end"
          onClose={() => setOpen(false)}
          className="w-[min(360px,calc(100vw-16px))]"
        >
          <p className="flex h-row shrink-0 items-center px-3 pt-1 text-xs text-fg-3">Pending batch edits on this page</p>
          <ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto overscroll-contain p-1">
            {props.notes.map((note, idx) => {
              const target =
                note.elements[0] !== undefined ? elementSummary(note.elements[0]) : note.area ? `Area ${note.area.width}×${note.area.height}` : "Page note";
              const detail =
                note.text.trim() ||
                (note.textEdit ? `"${note.textEdit.before}" → "${note.textEdit.after}"` : "") ||
                (note.cssEdits?.length ? `${note.cssEdits.length} CSS ${note.cssEdits.length === 1 ? "change" : "changes"}` : "Visual note");
              return (
                <li key={note.id} className="flex items-center gap-1 rounded-md px-2 py-1 hover:bg-hover">
                  <Button
                    variant="quiet"
                    size="xs"
                    onClick={() => {
                      setOpen(false);
                      props.onSelect(note);
                    }}
                    className="min-w-0 flex-1 justify-start text-left"
                  >
                    <span className="shrink-0 font-mono text-xs text-fg-3 tabular-nums">{`#${note.pinNumber ?? idx + 1}`}</span>
                    <span className="shrink-0 font-mono text-xs text-fg-2">{target}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-fg">{detail}</span>
                  </Button>
                  <IconButton icon={X} label={`Remove pin ${idx + 1}`} size="xs" onClick={() => props.onRemove(note.id)} />
                </li>
              );
            })}
          </ul>
          <div className="flex h-bar shrink-0 items-center justify-end border-t border-line px-2">
            <Button
              variant="quiet"
              size="xs"
              onClick={() => {
                props.onClearAll();
                setOpen(false);
              }}
            >
              Clear all
            </Button>
          </div>
        </Popover>
      </Presence>
    </>
  );
}
