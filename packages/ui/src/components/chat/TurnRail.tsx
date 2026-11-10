import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "../../lib/cn";
import { requestTitle } from "../../lib/comments";
import { formatDuration } from "../../lib/format";
import type { RequestSummary } from "../../lib/transcript";
import { useNav, useNavState } from "../../state/nav";

const STATE_TEXT = { done: "Done", working: "Working…", failed: "Failed", stopped: "Stopped" } as const;

function firstWords(text: string, n = 6): string {
  const words = requestTitle(text).split(/\s+/).filter(Boolean);
  return words.length > n ? `${words.slice(0, n).join(" ")}…` : words.join(" ");
}

/** Marker pitch: 8px while the rail fits, compressed down to 3px, then the rail scrolls (current kept in view). */
const PITCH = 8;
const MIN_PITCH = 3;

/**
 * One slim marker per request, stacked in the conversation's left padding (never over the column, 12px
 * clear of it). The rail never grows past the visible height (`maxHeight`): the pitch compresses from 8px
 * to 3px, and beyond that the rail scrolls with the request in view kept inside it. Inactive ticks are
 * quiet (`line-strong`); the request in view is emphasised (reuses the sidebar's in-view tracking). Hover
 * or focus shows a compact card with the request's first lines and its state, kept inside the rail's
 * height; click / Enter scrolls to it. One tab stop (roving focus, ↑/↓/Home/End). Markers sit below the
 * 24px hit-area rule, like the dividers: the rail is a skimming aid, and every request is also reachable
 * from the sidebar and the palette.
 */
export function TurnRail({ requests, projectId, now, maxHeight }: { requests: RequestSummary[]; projectId: string; now: number; maxHeight: number }) {
  const nav = useNav();
  const { viewTurn } = useNavState();
  const [shown, setShown] = useState<number | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const refs = useRef(new Map<number, HTMLButtonElement>());
  const list = useRef<HTMLUListElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const [cardTop, setCardTop] = useState(0);
  const current = viewTurn?.projectId === projectId ? viewTurn.messageId : null;
  const tabStop = focus ?? current ?? requests[requests.length - 1]?.id;
  const n = requests.length;
  const avail = Math.max(MIN_PITCH * 3, Math.floor(maxHeight));
  const pitch = Math.max(MIN_PITCH, Math.min(PITCH, Math.floor(avail / Math.max(1, n))));
  const height = Math.min(avail, pitch * n);

  // The request in view stays inside a scrolling rail.
  const currentIndex = requests.findIndex((r) => r.id === current);
  useLayoutEffect(() => {
    const el = list.current;
    if (!el || currentIndex < 0 || el.scrollHeight <= el.clientHeight) return;
    const y = currentIndex * pitch;
    if (y < el.scrollTop || y + pitch > el.scrollTop + el.clientHeight) el.scrollTop = y - el.clientHeight / 2;
  }, [currentIndex, pitch]);

  // The card is centred on its marker, then clamped inside the rail's box (never under the header).
  const shownIndex = requests.findIndex((r) => r.id === shown);
  useLayoutEffect(() => {
    const el = list.current;
    const c = card.current;
    if (!el || !c || shownIndex < 0) return;
    const centre = shownIndex * pitch + pitch / 2 - el.scrollTop;
    const h = c.getBoundingClientRect().height;
    setCardTop(Math.round(Math.max(0, Math.min(Math.max(height, avail) - h, centre - h / 2))));
  }, [shownIndex, pitch, height, avail]);

  const go = (id: number) => nav.requestTurn({ projectId, messageId: id });
  const onKeyDown = (e: KeyboardEvent, i: number) => {
    const to = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : null;
    if (to === null || !requests[to]) return;
    e.preventDefault();
    refs.current.get(requests[to].id)?.focus();
  };
  const tick = pitch >= 4 ? "h-0.5" : "h-px";
  const r = shownIndex >= 0 ? requests[shownIndex] : null;
  const duration = r ? (r.endedAt !== null ? r.endedAt - r.startedAt : r.state === "working" ? now - r.startedAt : null) : null;

  return (
    <div className="relative">
      <ul ref={list} aria-label="Requests in this conversation" className="flex flex-col overflow-hidden" style={{ height }}>
        {requests.map((req, i) => {
          const active = req.id === current;
          return (
            <li key={req.id} className="shrink-0" style={{ height: pitch }}>
              <button
                ref={(el) => {
                  if (el) refs.current.set(req.id, el);
                  else refs.current.delete(req.id);
                }}
                type="button"
                aria-label={`Go to request: ${firstWords(req.text)}`}
                aria-current={active ? "location" : undefined}
                aria-describedby={shown === req.id ? "octo-rail-card" : undefined}
                tabIndex={req.id === tabStop ? 0 : -1}
                onClick={() => go(req.id)}
                onKeyDown={(e) => onKeyDown(e, i)}
                onPointerEnter={() => setShown(req.id)}
                onPointerLeave={() => setShown((s) => (s === req.id ? null : s))}
                onFocus={() => {
                  setFocus(req.id);
                  setShown(req.id);
                }}
                onBlur={() => setShown((s) => (s === req.id ? null : s))}
                className="group/mark grid h-full w-3 place-items-center rounded-2xs"
              >
                <span
                  aria-hidden
                  className={cn(
                    tick,
                    "rounded-full transition-[width,background-color] duration-100",
                    active ? "w-3 bg-fg-2" : "w-2 bg-line-strong group-hover/mark:bg-fg-3",
                    req.state === "working" && !active && "bg-accent",
                    req.state === "failed" && !active && "bg-err",
                  )}
                />
              </button>
            </li>
          );
        })}
      </ul>
      {r && (
        <div
          ref={card}
          id="octo-rail-card"
          role="tooltip"
          style={{ top: cardTop }}
          className="pointer-events-none absolute left-full z-30 ml-2 w-[min(320px,60vw)] rounded-md bg-overlay p-3 text-sm shadow-pop"
        >
          <p className="line-clamp-3 wrap-anywhere whitespace-pre-wrap text-fg">{requestTitle(r.text).replace(/\n\s*\n+/g, "\n")}</p>
          <p className={cn("mt-1 flex gap-2 text-xs tabular-nums", r.state === "failed" ? "text-err" : "text-fg-3")}>
            <span>{STATE_TEXT[r.state]}</span>
            {duration !== null && duration >= 1000 && <span className="text-fg-3">{formatDuration(duration)}</span>}
          </p>
        </div>
      )}
    </div>
  );
}
