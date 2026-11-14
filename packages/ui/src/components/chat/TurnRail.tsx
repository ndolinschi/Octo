import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "../../lib/cn";
import { requestTitle } from "../../lib/comments";
import { formatDuration, timeAgo } from "../../lib/format";
import type { RequestSummary } from "../../lib/transcript";
import { useNav, useNavState } from "../../state/nav";

const STATE_TEXT = { done: "Done", working: "Working…", failed: "Failed", stopped: "Stopped" } as const;

function firstWords(text: string, n = 6): string {
  const words = requestTitle(text).split(/\s+/).filter(Boolean);
  return words.length > n ? `${words.slice(0, n).join(" ")}…` : words.join(" ");
}

/** Decision 57: ticks 6px apart; the rail takes at most 60% of the conversation's height, then scrolls. */
const PITCH = 6;
/** Round 3: with room (few requests) the pitch grows to 16px so each target is 24x16; a dense rail shrinks back to PITCH. */
const MAX_PITCH = 16;
const MAX_SHARE = 0.6;
/**
 * The rail's padding above the first tick and below the last: their targets reach 14px tall (8 + 6). Between ticks
 * each target is its own 6px cell, the part of the rail nearest its tick, so a dense rail has no overlapping targets.
 */
const EDGE = 8;

/**
 * The request rail (decision 57): one tick per request, 6px apart, in the conversation's left padding (never over the
 * column), centred on the conversation's height. Ticks are 8px wide and 1px thick in a quiet tone, the request in view
 * 12px in `fg`; past 60% of the height the rail scrolls itself to keep the current tick centred. Hover or focus shows
 * the request's first line beside its tick; click / Enter jumps (Alt+↑/↓ from the conversation too). One tab stop
 * (roving focus, ↑/↓/Home/End); each tick's target is 24px wide, so the rail is reachable with a pointer despite its pitch.
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
  const avail = Math.max(PITCH * 3, Math.floor(maxHeight * MAX_SHARE));
  const pitch = Math.min(MAX_PITCH, Math.max(PITCH, Math.floor(avail / Math.max(1, n))));
  const height = Math.min(avail, pitch * n) + 2 * EDGE;

  // The request in view stays inside a scrolling rail.
  const currentIndex = requests.findIndex((r) => r.id === current);
  useLayoutEffect(() => {
    const el = list.current;
    if (!el || currentIndex < 0 || el.scrollHeight <= el.clientHeight) return;
    el.scrollTop = EDGE + currentIndex * pitch + pitch / 2 - el.clientHeight / 2;
  }, [currentIndex, pitch]);

  // The card is centred on its marker, then clamped inside the rail's box (never under the header).
  const shownIndex = requests.findIndex((r) => r.id === shown);
  useLayoutEffect(() => {
    const el = list.current;
    const c = card.current;
    if (!el || !c || shownIndex < 0) return;
    const centre = EDGE + shownIndex * pitch + pitch / 2 - el.scrollTop;
    const h = c.getBoundingClientRect().height;
    setCardTop(Math.round(centre - h / 2));
  }, [shownIndex, pitch]);

  const go = (id: number) => nav.requestTurn({ projectId, messageId: id });
  const onKeyDown = (e: KeyboardEvent, i: number) => {
    const to = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : null;
    if (to === null || !requests[to]) return;
    e.preventDefault();
    refs.current.get(requests[to].id)?.focus();
  };
  const r = shownIndex >= 0 ? requests[shownIndex] : null;
  const duration = r ? (r.endedAt !== null ? r.endedAt - r.startedAt : r.state === "working" ? now - r.startedAt : null) : null;

  return (
    <div data-rail className="relative">
      {/* 24 wide like the targets (the scrolling list clipped them to the 12px tick before); placed by its right edge, the ticks keep their place. */}
      <ul ref={list} aria-label="Requests in this conversation" className="flex w-6 flex-col items-end overflow-hidden py-2" style={{ height }}>
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
                // Decision 36: 24px wide (it grows leftwards, away from the column) × its cell; the end ticks reach into the rail's padding (14 tall).
                className={cn(
                  "group/mark relative flex h-full w-3 items-center justify-end before:absolute before:inset-y-0 before:right-0 before:w-6 before:content-['']",
                  i === 0 && "before:-top-2",
                  i === n - 1 && "before:-bottom-2",
                  "focus-visible:shadow-none focus-visible:after:absolute focus-visible:after:-inset-x-1 focus-visible:after:-inset-y-0.5 focus-visible:after:rounded-2xs focus-visible:after:shadow-[0_0_0_1px_var(--octo-focus)] focus-visible:after:content-['']",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "h-px transition-[width,background-color] duration-100",
                    active ? "w-3 bg-fg" : "w-2 bg-line-strong group-hover/mark:bg-fg-3",
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
          className="pointer-events-none absolute left-full z-30 ml-3 w-[min(320px,60vw)] rounded-md bg-overlay p-3 text-sm shadow-pop"
        >
          <p className="line-clamp-3 wrap-anywhere whitespace-pre-wrap text-fg">{requestTitle(r.text).replace(/\n\s*\n+/g, "\n")}</p>
          <p className={cn("mt-1 flex gap-2 text-xs tabular-nums", r.state === "failed" ? "text-err" : "text-fg-3")}>
            <span>{STATE_TEXT[r.state]}</span>
            <time dateTime={new Date(r.startedAt).toISOString()} className="text-fg-3">
              {timeAgo(new Date(r.startedAt).toISOString(), now)}
            </time>
            {duration !== null && duration >= 1000 && <span className="text-fg-3">{formatDuration(duration)}</span>}
          </p>
        </div>
      )}
    </div>
  );
}
