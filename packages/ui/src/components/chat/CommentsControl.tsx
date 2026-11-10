import { MessageSquare, X } from "lucide-react";
import { useRef, useState } from "react";
import { linesLabel, type CodeComment } from "../../lib/comments";
import { fileName } from "../../lib/files";
import { cn } from "../../lib/cn";
import { useComments } from "../../state/comments";
import { Popover } from "../primitives/Popover";
import { Presence } from "../primitives/Presence";

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
 * "N comments" in the composer footer: the pending code comments that go out with the next
 * message. Opens a compact list grouped by file (jump to the lines, remove one, remove all).
 */
export function CommentsControl() {
  const store = useComments();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const n = store.comments.length;
  if (!n) return null;
  const label = `${n} ${n === 1 ? "comment" : "comments"}`;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${n} ${n === 1 ? "comment" : "comments"}`}
        title="Pending comments, sent with your next message"
        onClick={() => setOpen((x) => !x)}
        className={cn(
          "press flex h-row shrink-0 items-center gap-1 rounded-sm px-2 text-xs tabular-nums hover:bg-hover hover:text-fg",
          open ? "bg-active text-fg" : "text-fg-2",
        )}
      >
        <MessageSquare size={12} strokeWidth={1.5} absoluteStrokeWidth aria-hidden />
        {label}
      </button>
      <Presence show={open}>
        <Popover
          anchor={anchor}
          edge={() => anchor.current?.closest<HTMLElement>("[data-composer]") ?? null}
          label="Pending comments"
          side="top"
          onClose={() => setOpen(false)} className="w-[min(380px,calc(100vw-16px))]">
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line pr-1.5 pl-3">
            <p className="min-w-0 flex-1 truncate text-xs text-fg-3">Sent with your next message</p>
            <button
              type="button"
              onClick={() => {
                store.removeAll();
                setOpen(false);
              }}
              className="press h-6 shrink-0 rounded-sm px-1.5 text-xs text-fg-2 hover:bg-hover hover:text-fg"
            >
              Remove all
            </button>
          </div>
          <div className="overflow-y-auto overscroll-contain p-1">
            {byFile(store.comments).map((g) => (
              <section key={g.key} aria-label={`${g.folder}/${g.path}`} className="not-first:mt-1">
                <h3 className="flex h-7 items-center gap-2 px-2 text-xs" title={`${g.folder}/${g.path}`}>
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
                        className="press-row flex h-8 w-full items-center gap-3 rounded-xs pr-9 pl-2 text-left hover:bg-hover focus-visible:bg-active focus-visible:shadow-none"
                      >
                        <span className="w-[72px] shrink-0 text-xs whitespace-nowrap text-fg-3 tabular-nums">{linesLabel(c.start, c.end).replace(/^l/, "L")}</span>
                        <span className="min-w-0 flex-1 truncate text-sm text-fg">{c.text.split("\n", 1)[0]}</span>
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove comment on ${linesLabel(c.start, c.end)} of ${fileName(c.path)}`}
                        title="Remove comment"
                        onClick={() => store.remove(c.id)}
                        className="press absolute top-1 right-1 grid size-6 place-items-center rounded-xs text-fg-3 opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 hover:bg-hover hover:text-fg focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                      >
                        <X size={12} strokeWidth={1.5} absoluteStrokeWidth aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </Popover>
      </Presence>
    </>
  );
}
