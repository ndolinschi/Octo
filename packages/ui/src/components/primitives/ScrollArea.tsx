import { useRef, type HTMLAttributes, type Ref } from "react";
import { cn } from "../../lib/cn";
import { useScrollFade } from "../../lib/hooks";
import { mergeRefs } from "../../lib/refs";

type Axis = "y" | "x" | "both";
type Gutter = "none" | "stable" | "both";

/** A ref that never holds an element: the scroll-fade hook then observes nothing. */
const NO_REF = { current: null };

const AXIS: Record<Axis, string> = { y: "overflow-x-hidden overflow-y-auto", x: "overflow-x-auto overflow-y-hidden", both: "overflow-auto" };
const GUTTER: Record<Gutter, string> = { none: "", stable: "scroll-gutter", both: "scroll-quiet" };

/**
 * The one scroll container (decision 90; the code base had 34 of them with eight different companion sets). Every region
 * that scrolls is a `ScrollArea`, so the treatment is the same everywhere: the thin scrollbar of `styles.css`, overscroll
 * contained (a list at its end never scrolls the page behind it), and the options below.
 *
 * - `axis`: `y` (default), `x`, `both`.
 * - `gutter`: `stable` reserves the scrollbar's width so content does not shift when it appears (decision 69), `both` on both
 *   edges so centred content lines up with rows that do not scroll.
 * - `fade`: the ends that have more content fade out and the scrollbar is hidden (lists whose rows keep the panel's insets);
 *   one axis only.
 * - `contain`: `false` lets the scroll chain to the parent (rare).
 * - Give it a height from its parent (`min-h-0 flex-1` in a flex column, or a max height). A region with no focusable
 *   child needs `tabIndex={0}` and a `role="region"` with a label so the keyboard can scroll it.
 *
 * Not for: a Monaco editor or the transcript (they own their scrolling), a popover list that `Picker` already wraps.
 */
export function ScrollArea({
  axis = "y",
  gutter = "none",
  fade = false,
  contain = true,
  className,
  ref,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { axis?: Axis; gutter?: Gutter; fade?: boolean; contain?: boolean; ref?: Ref<HTMLDivElement> }) {
  const own = useRef<HTMLDivElement>(null);
  useScrollFade(fade ? own : NO_REF, axis === "x" ? "x" : "y");
  return (
    <div
      ref={mergeRefs(own, ref)}
      className={cn(AXIS[axis], contain && "overscroll-contain", GUTTER[gutter], fade && (axis === "x" ? "fade-x" : "fade-y"), className)}
      {...rest}
    />
  );
}
