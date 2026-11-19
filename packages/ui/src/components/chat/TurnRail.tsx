import { memo, useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "../../lib/cn";
import { requestTitle } from "../../lib/comments";
import { formatDuration, timeAgo } from "../../lib/format";
import type { RequestSummary } from "../../lib/transcript";
import { railLayout } from "../../lib/railLayout";
import { useNav, useNavState } from "../../state/nav";

const STATE_TEXT = { done: "Done", working: "Working…", failed: "Failed", stopped: "Stopped" } as const;

function firstWords(text: string, n = 6): string {
  const words = requestTitle(text).split(/\s+/).filter(Boolean);
  return words.length > n ? `${words.slice(0, n).join(" ")}…` : words.join(" ");
}

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
export const TurnRail = memo(function TurnRail({
  requests,
  projectId,
  now,
  maxHeight,
}: {
  requests: RequestSummary[];
  projectId: string;
  now: number;
  maxHeight: number;
}) {
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
  // N7: targets 16 tall with room, at least 12 while the height holds them, then nearest-wins cells (`railLayout`).
  const { pitch, height } = railLayout(n, maxHeight, EDGE);

  // The request in view stays inside a scrolling rail. Whether it scrolls is known from its layout (the list is `height` tall
  // with EDGE inside; the ticks are `pitch` apart): reading the list's box here forced a layout of the page on every turn
  // boundary while scrolling the conversation.
  const currentIndex = requests.findIndex((r) => r.id === current);
  const scrolls = n * pitch + 2 * EDGE > height;
  useLayoutEffect(() => {
    const el = list.current;
    if (!el || currentIndex < 0 || !scrolls) return;
    el.scrollTop = EDGE + currentIndex * pitch + pitch / 2 - height / 2;
  }, [currentIndex, pitch, height, scrolls]);

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

  // Stable handlers: a tick re-renders only when its own state changes (stress P1-6: 500 ticks re-rendered on every streamed delta).
  const go = useCallback((id: number) => nav.requestTurn({ projectId, messageId: id }), [nav, projectId]);
  const onKeyDown = useCallback(
    (e: KeyboardEvent, i: number) => {
      const to = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? requests.length - 1 : null;
      if (to === null || !requests[to]) return;
      e.preventDefault();
      refs.current.get(requests[to].id)?.focus();
    },
    [requests],
  );
  const register = useCallback((id: number, el: HTMLButtonElement | null) => {
    if (el) refs.current.set(id, el);
    else refs.current.delete(id);
  }, []);
  const r = shownIndex >= 0 ? requests[shownIndex] : null;
  const duration = r ? (r.endedAt !== null ? r.endedAt - r.startedAt : r.state === "working" ? now - r.startedAt : null) : null;

  return (
    <div data-rail className="relative">
      {/* 24 wide like the targets (the scrolling list clipped them to the 12px tick before); placed by its right edge, the ticks keep their place. */}
      <ul ref={list} aria-label="Requests in this conversation" className="flex w-6 flex-col items-end overflow-hidden py-2" style={{ height }}>
        {requests.map((req, i) => (
          <RailTick
            key={req.id}
            req={req}
            index={i}
            last={i === n - 1}
            pitch={pitch}
            active={req.id === current}
            tabStop={req.id === tabStop}
            describedBy={shown === req.id}
            go={go}
            onKeyDown={onKeyDown}
            register={register}
            setShown={setShown}
            setFocus={setFocus}
          />
        ))}
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
});

type TickProps = {
  req: RequestSummary;
  index: number;
  last: boolean;
  pitch: number;
  active: boolean;
  tabStop: boolean;
  describedBy: boolean;
  go(id: number): void;
  onKeyDown(e: KeyboardEvent, i: number): void;
  register(id: number, el: HTMLButtonElement | null): void;
  setShown: (update: (s: number | null) => number | null) => void;
  setFocus(id: number): void;
};

const RailTick = memo(function RailTick({ req, index: i, last, pitch, active, tabStop, describedBy, go, onKeyDown, register, setShown, setFocus }: TickProps) {
  return (
    <li className="shrink-0" style={{ height: pitch }}>
      <button
        ref={(el) => register(req.id, el)}
        type="button"
        aria-label={`Go to request: ${firstWords(req.text)}`}
        aria-current={active ? "location" : undefined}
        aria-describedby={describedBy ? "octo-rail-card" : undefined}
        tabIndex={tabStop ? 0 : -1}
        onClick={() => go(req.id)}
        onKeyDown={(e) => onKeyDown(e, i)}
        onPointerEnter={() => setShown(() => req.id)}
        onPointerLeave={() => setShown((s) => (s === req.id ? null : s))}
        onFocus={() => {
          setFocus(req.id);
          setShown(() => req.id);
        }}
        onBlur={() => setShown((s) => (s === req.id ? null : s))}
        // Decision 36, N7: the button itself is 24px wide × its cell (the mark is drawn at its right edge, so the ticks keep their
        // place); the end ticks reach into the rail's padding with a pseudo-element of the same width.
        className={cn(
          "group/mark relative flex h-full w-6 items-center justify-end before:absolute before:inset-x-0 before:inset-y-0 before:content-['']",
          i === 0 && "before:-top-2",
          last && "before:-bottom-2",
          "focus-visible:shadow-none focus-visible:after:absolute focus-visible:after:-inset-x-1 focus-visible:after:-inset-y-0.5 focus-visible:after:rounded-2xs focus-visible:after:shadow-[0_0_0_1px_var(--octo-focus)] focus-visible:after:content-['']",
        )}
      >
        <span
          aria-hidden
          className={cn(
            // The mark grows by scale from its right end (never by width: layout).
            "h-px w-3 origin-right transition-[scale,background-color] duration-fast",
            active ? "bg-fg" : "scale-x-67 bg-line-strong group-hover/mark:bg-fg-3",
            req.state === "working" && !active && "bg-accent",
            req.state === "failed" && !active && "bg-err",
          )}
        />
      </button>
    </li>
  );
}, sameTick);

/** Request summaries are rebuilt whenever a message lands: a tick compares what it shows, not the object. */
function sameTick(a: TickProps, b: TickProps): boolean {
  return (
    a.req.id === b.req.id &&
    a.req.text === b.req.text &&
    a.req.state === b.req.state &&
    a.index === b.index &&
    a.last === b.last &&
    a.pitch === b.pitch &&
    a.active === b.active &&
    a.tabStop === b.tabStop &&
    a.describedBy === b.describedBy &&
    a.go === b.go &&
    a.onKeyDown === b.onKeyDown &&
    a.register === b.register &&
    a.setShown === b.setShown &&
    a.setFocus === b.setFocus
  );
}
