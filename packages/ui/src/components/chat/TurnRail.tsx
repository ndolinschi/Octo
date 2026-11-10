import { useRef, useState, type KeyboardEvent } from "react";
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

/**
 * One slim marker per request, stacked in the conversation's left padding (never over the column).
 * The request in view is emphasised (reuses the sidebar's in-view tracking). Hover or focus shows a
 * compact card with the request's first lines and its state; click / Enter scrolls to it. One tab stop
 * (roving focus, ↑/↓/Home/End). Markers are 8px tall, below the 24px hit-area rule, like the dividers:
 * the rail is a skimming aid, and every request is also reachable from the sidebar and the palette.
 */
export function TurnRail({ requests, projectId, now }: { requests: RequestSummary[]; projectId: string; now: number }) {
  const nav = useNav();
  const { viewTurn } = useNavState();
  const [shown, setShown] = useState<number | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const refs = useRef(new Map<number, HTMLButtonElement>());
  const current = viewTurn?.projectId === projectId ? viewTurn.messageId : null;
  const tabStop = focus ?? current ?? requests[requests.length - 1]?.id;

  const go = (id: number) => nav.requestTurn({ projectId, messageId: id });
  const onKeyDown = (e: KeyboardEvent, i: number) => {
    const to = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? requests.length - 1 : null;
    if (to === null || !requests[to]) return;
    e.preventDefault();
    refs.current.get(requests[to].id)?.focus();
  };

  return (
    <ul aria-label="Requests in this conversation" className="flex flex-col">
      {requests.map((r, i) => {
        const active = r.id === current;
        const duration = r.endedAt !== null ? r.endedAt - r.startedAt : r.state === "working" ? now - r.startedAt : null;
        return (
          <li key={r.id} className="relative">
            <button
              ref={(el) => {
                if (el) refs.current.set(r.id, el);
                else refs.current.delete(r.id);
              }}
              type="button"
              aria-label={`Go to request: ${firstWords(r.text)}`}
              aria-current={active ? "location" : undefined}
              aria-describedby={shown === r.id ? `octo-rail-card-${r.id}` : undefined}
              tabIndex={r.id === tabStop ? 0 : -1}
              onClick={() => go(r.id)}
              onKeyDown={(e) => onKeyDown(e, i)}
              onPointerEnter={() => setShown(r.id)}
              onPointerLeave={() => setShown((s) => (s === r.id ? null : s))}
              onFocus={() => {
                setFocus(r.id);
                setShown(r.id);
              }}
              onBlur={() => setShown((s) => (s === r.id ? null : s))}
              className="group/mark grid h-2 w-4 place-items-center rounded-2xs"
            >
              <span
                aria-hidden
                className={cn(
                  "h-0.5 rounded-full transition-[width,background-color] duration-100",
                  active ? "w-4 bg-fg" : "w-3 bg-fg-3 group-hover/mark:bg-fg-2",
                  r.state === "working" && !active && "bg-accent",
                  r.state === "failed" && !active && "bg-err",
                )}
              />
            </button>
            {shown === r.id && (
              <div
                id={`octo-rail-card-${r.id}`}
                role="tooltip"
                className="pointer-events-none absolute top-1/2 left-full z-30 ml-2 w-[min(320px,60vw)] -translate-y-1/2 rounded-md bg-overlay p-3 text-sm shadow-pop"
              >
                <p className="line-clamp-3 whitespace-pre-wrap wrap-anywhere text-fg">{requestTitle(r.text).replace(/\n\s*\n+/g, "\n")}</p>
                <p className={cn("mt-1 flex gap-2 text-xs tabular-nums", r.state === "failed" ? "text-err" : "text-fg-3")}>
                  <span>{STATE_TEXT[r.state]}</span>
                  {duration !== null && duration >= 1000 && <span className="text-fg-3">{formatDuration(duration)}</span>}
                </p>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
