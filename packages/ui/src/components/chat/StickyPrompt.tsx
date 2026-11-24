import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { STICK_TOP } from "./turnTracking";
import { useLatest } from "../../lib/hooks";

/**
 * The prompt of the turn being read, pinned over the top of the scroll area once its own copy has
 * scrolled out entirely (never two boxes at once). Opaque, with a 24px fade below (12 on short viewports: content reads as passing under it, never hard-cut); long prompts clamp (three lines, one on short
 * viewports) and expand on click. It overlays the transcript (not in flow), so pinning never shifts
 * the content. It reserves the scroll area's gutters the same way (`scroll-quiet` + `overflow: hidden`)
 * and pads by the conversation's `--pad`, so its edges match the transcript column and it never covers
 * the scrollbar.
 */
export function StickyPrompt(props: { text: string; author: string | null; onHeight(px: number): void }) {
  const box = useRef<HTMLSpanElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const onHeight = useLatest(props.onHeight);

  // The conversation needs the copy's full height (fade included) to know when to let it go.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const report = () => onHeight.current(el.getBoundingClientRect().height);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onHeight]);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const [oneLine, setOneLine] = useState(false);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el || expanded) return;
    const check = () => {
      setClamped(el.scrollHeight > el.clientHeight + 1);
      setOneLine(el.clientHeight <= parseFloat(getComputedStyle(el).lineHeight) * 1.5);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [props.text, expanded]);

  const body = (
    <>
      {props.author && <span className="mb-0.5 block text-xs opacity-80">From {props.author}</span>}
      <span
        ref={box}
        className={cn(
          "wrap-anywhere whitespace-pre-wrap",
          // No `block` here: line-clamp sets its own display (flow-root) and `block` would cancel it.
          expanded ? "block max-h-[40vh] overflow-y-auto overscroll-contain" : "line-clamp-3 [@media(max-height:640px)]:line-clamp-1",
        )}
      >
        {props.text}
      </span>
    </>
  );
  // R2 (addition 10): the request bubble's shape and fill (styles.css, `[data-pinned-box] > button`), right-aligned.
  const boxClass = "block text-left text-base forced-colors:border";

  return (
    <div ref={root} data-pinned className="pointer-events-none absolute inset-x-0 top-0 z-10 overflow-hidden scroll-quiet">
      <div className="bg-panel px-(--pad)" style={{ paddingTop: STICK_TOP }}>
        <div data-pinned-box className="pointer-events-auto mx-auto w-full max-w-measure">
          {/* One element in both states (a swap would remount the measured text and lose `clamped`). */}
          <button
            type="button"
            data-one-line={(oneLine && !props.author && !expanded) || undefined}
            aria-expanded={clamped || expanded ? expanded : undefined}
            aria-label={clamped || expanded ? (expanded ? "Collapse the pinned request" : "Expand the pinned request") : undefined}
            aria-hidden={clamped || expanded ? undefined : true}
            tabIndex={clamped || expanded ? undefined : -1}
            onClick={() => (clamped || expanded) && setExpanded((x) => !x)}
            className={cn(boxClass, clamped || expanded ? "press-row transition-colors duration-fast hover:border-line-strong" : "pointer-events-none")}
          >
            {body}
          </button>
        </div>
      </div>
      {/* Short eased fade so scrolling content reads as passing under the pin without excessive dead height. */}
      <div aria-hidden className="octo-pin-fade h-6 [@media(max-height:640px)]:h-4" />
    </div>
  );
}
