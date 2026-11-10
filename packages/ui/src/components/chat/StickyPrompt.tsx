import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { STICK_TOP } from "./turnTracking";

/**
 * The prompt of the turn being read, pinned over the top of the scroll area once its own copy has
 * scrolled out entirely (never two boxes at once). Opaque, with a short fade below; long prompts clamp (three lines, one on short
 * viewports) and expand on click. It overlays the transcript (not in flow), so pinning never shifts
 * the content. It spans the scroll area minus the scrollbar and uses the conversation's `--pad` /
 * `--sg` insets, so its edges match the transcript column.
 */
export function StickyPrompt(props: { text: string; author: string | null; onHeight(px: number): void }) {
  const box = useRef<HTMLSpanElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const onHeight = useRef(props.onHeight);
  useLayoutEffect(() => {
    onHeight.current = props.onHeight;
  });

  // The conversation needs the copy's full height (fade included) to know when to let it go.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const report = () => onHeight.current(el.getBoundingClientRect().height);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el || expanded) return;
    const check = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [props.text, expanded]);

  const body = (
    <>
      {props.author && <span className="mb-0.5 block text-xs text-fg-3">From {props.author}</span>}
      <span
        ref={box}
        className={cn(
          "whitespace-pre-wrap wrap-anywhere",
          // No `block` here: line-clamp sets its own display (flow-root) and `block` would cancel it.
          expanded ? "block max-h-[40vh] overflow-y-auto overscroll-contain" : "line-clamp-3 [@media(max-height:640px)]:line-clamp-1",
        )}
      >
        {props.text}
      </span>
    </>
  );
  const boxClass = "block w-full rounded-md border border-line bg-raised p-card text-left text-base text-fg";

  return (
    <div ref={root} data-pinned className="pointer-events-none absolute top-0 left-0 z-10 right-(--sg)">
      <div className="bg-panel pr-(--pad) pl-[calc(var(--pad)+var(--sg))]" style={{ paddingTop: STICK_TOP }}>
        <div data-pinned-box className="pointer-events-auto mx-auto w-full max-w-measure">
          {clamped || expanded ? (
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={expanded ? "Collapse the pinned request" : "Expand the pinned request"}
              onClick={() => setExpanded((x) => !x)}
              className={cn(boxClass, "press-row hover:border-line-strong")}
            >
              {body}
            </button>
          ) : (
            <div aria-hidden className={boxClass}>
              {body}
            </div>
          )}
        </div>
      </div>
      <div aria-hidden className="h-3 bg-linear-to-b from-panel to-transparent [@media(max-height:640px)]:h-2" />
    </div>
  );
}
