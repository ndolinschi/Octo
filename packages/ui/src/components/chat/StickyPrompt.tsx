import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { STICK_TOP } from "./turnTracking";

/**
 * The prompt of the turn being read, pinned over the top of the scroll area once its own copy has
 * scrolled under. Opaque, with a soft fade below; long prompts clamp to three lines and expand on
 * click. It overlays the transcript (not in flow), so pinning never shifts the content.
 */
export function StickyPrompt(props: { text: string; author: string | null; gutter: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);

  useLayoutEffect(() => {
    const el = box.current;
    if (el && !expanded) setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [props.text, expanded]);

  const body = (
    <>
      {props.author && <span className="mb-0.5 block text-xs text-fg-3">From {props.author}</span>}
      <span ref={box} className={cn("block whitespace-pre-wrap", expanded ? "max-h-[40vh] overflow-y-auto" : "line-clamp-3")}>
        {props.text}
      </span>
    </>
  );
  const boxClass = "block w-full rounded-md border border-line bg-raised px-3.5 py-2.5 text-left text-base text-fg";

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10" style={{ right: props.gutter }}>
      <div className="bg-panel" style={{ paddingTop: STICK_TOP }}>
        <div className="pointer-events-auto mx-auto w-full max-w-measure px-6 max-[1000px]:px-4">
          {clamped || expanded ? (
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={expanded ? "Collapse the pinned request" : "Expand the pinned request"}
              onClick={() => setExpanded((x) => !x)}
              className={cn(boxClass, "transition-[border-color] duration-100 hover:border-line-strong")}
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
      <div aria-hidden className="h-6 bg-linear-to-b from-panel to-transparent" />
    </div>
  );
}
