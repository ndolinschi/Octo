import { MessageSquare, X } from "lucide-react";
import { Glyph } from "../primitives/Glyph";
import { useRef, useState } from "react";
import { linesLabel, type CodeComment } from "../../lib/comments";
import { fileName } from "../../lib/files";
import { cn } from "../../lib/cn";
import { useOptionalComments } from "../../state/comments";
import { useStagedDesignNotesCount } from "../../state/designNotes";
import { useProject } from "../../state/project";
import { Button } from "../primitives/Button";
import { IconButton } from "../primitives/IconButton";
import { Popover } from "../primitives/Popover";
import { Presence } from "../primitives/Presence";
import { PILL } from "./ComposerPills";
import { DesignNotesControl } from "./DesignNotesControl";

function byFile(comments: CodeComment[]): { key: string; folder: string; path: string; items: CodeComment[] }[] {
  const groups = new Map<string, { key: string; folder: string; path: string; items: CodeComment[] }>();
  for (const c of comments) {
    const key = `${c.folder}/${c.path}`;
    const g = groups.get(key) ?? { key, folder: c.folder, path: c.path, items: [] };
    g.items.push(c);
    groups.set(key, g);
  }
  for (const g of groups.values()) g.items.sort((a, b) => a.start - b.start);
  return [...groups.values()];
}

/**
 * "N comments": the pending code comments that go out with the next message — in the composer footer,
 * or as a status chip over a file (`variant="chip"`). Opens a compact list grouped by file (jump to the
 * lines, remove one, remove all). `open` / `onOpenChange` let the composer's "+" menu open it.
 */
export function CommentsControl(props: { open?: boolean; onOpenChange?(open: boolean): void; variant?: "pill" | "chip" }) {
  const store = useOptionalComments();
  const { projectId } = useProject();
  const stagedDesignCount = useStagedDesignNotesCount(projectId);
  const chip = props.variant === "chip";
  const designCount = chip ? 0 : stagedDesignCount;
  const [ownOpen, setOwnOpen] = useState(false);
  const open = props.open ?? ownOpen;
  const setOpen = (next: boolean | ((x: boolean) => boolean)) => {
    const value = typeof next === "function" ? next(open) : next;
    setOwnOpen(value);
    props.onOpenChange?.(value);
  };
  const anchor = useRef<HTMLButtonElement>(null);
  const n = store?.comments.length ?? 0;
  if (!n) return designCount > 0 ? <DesignNotesControl open={props.open} onOpenChange={props.onOpenChange} /> : null;
  if (!store) return null;
  const label = `${n} ${n === 1 ? "comment" : "comments"}`;
  const pill = (
    <>
      <button
        ref={anchor}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={label}
        title="Pending comments, sent with your next message"
        onClick={() => setOpen((x) => !x)}
        className={cn(
          chip
            ? "octo-ring-float touch-hit flex h-6 shrink-0 press items-center gap-1.5 rounded-full bg-overlay px-2 text-xs tabular-nums shadow-float hover:text-fg forced-colors:border forced-colors:border-[CanvasText]"
            : cn(PILL, "touch-hit press pr-2 tabular-nums hover:bg-active hover:text-fg"),
          open ? (chip ? "text-fg" : "bg-active text-fg") : chip ? "text-fg-2" : "text-fg",
        )}
      >
        <Glyph icon={MessageSquare} size={14} className={chip ? undefined : "text-fg-3"} />
        {`${n}\u00a0${n === 1 ? "comment" : "comments"}`}
      </button>
      <Presence show={open}>
        <Popover anchor={anchor} label="Pending comments" side="top" gap={4} onClose={() => setOpen(false)} className="w-[min(380px,calc(100vw-16px))]">
          {/* B23: the list comes first, so focus opens on the first comment; "Remove all" is the last stop, in the footer. */}
          <p className="flex h-row shrink-0 items-center px-4 pt-1 text-xs text-fg-3">Sent with your next message</p>
          <div className="overflow-y-auto overscroll-contain p-1">
            {byFile(store.comments).map((g) => (
              <section key={g.key} aria-label={`${g.folder}/${g.path}`} className="not-first:mt-1">
                <h3 className="flex h-row items-center gap-2 px-2 text-xs" title={`${g.folder}/${g.path}`}>
                  <span className="shrink-0 font-mono text-fg">{fileName(g.path)}</span>
                  <span className="min-w-0 truncate font-mono text-fg-3" dir="rtl">
                    {/* RTL truncation keeps the end of the path (nearest the file) visible. */}
                    <bdi>{`${g.folder}/${g.path.slice(0, Math.max(0, g.path.lastIndexOf("/")))}`}</bdi>
                  </span>
                </h3>
                <ul>
                  {g.items.map((c) => (
                    <li key={c.id} className="group/row relative">
                      <button
                        type="button"
                        onClick={() => {
                          setOpen(false);
                          store.reveal(c);
                        }}
                        aria-label={`Go to ${linesLabel(c.start, c.end)} of ${fileName(c.path)}: ${c.text}`}
                        className="flex h-row-nav w-full items-center gap-3 rounded-sm px-2 text-left press-row hover:bg-hover focus-visible:bg-active focus-visible:shadow-none"
                      >
                        <span className="w-[72px] shrink-0 text-xs whitespace-nowrap text-fg-3 tabular-nums">
                          {linesLabel(c.start, c.end).replace(/^l/, "L")}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm text-fg">{c.text.split("\n", 1)[0]}</span>
                        {/* Room for the remove button that sits over the row's end. */}
                        <span aria-hidden className="w-6 shrink-0" />
                      </button>
                      <IconButton
                        icon={X}
                        size="xs"
                        label={`Remove comment on ${linesLabel(c.start, c.end)} of ${fileName(c.path)}`}
                        onClick={() => store.remove(c.id)}
                        className="absolute top-1 right-1 opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 focus-visible:opacity-100 touch:opacity-100"
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          <div className="flex h-bar shrink-0 items-center justify-end border-t border-line px-2">
            <Button
              size="xs"
              variant="quiet"
              onClick={() => {
                store.removeAll();
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
  return designCount > 0 ? (
    <span className="flex flex-wrap items-center gap-1.5">
      {pill}
      <DesignNotesControl />
    </span>
  ) : (
    pill
  );
}
