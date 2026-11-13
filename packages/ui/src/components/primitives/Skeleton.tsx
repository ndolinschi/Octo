import { cn } from "../../lib/cn";
import { CONTROL, type ControlSize } from "../../lib/controls";

type Shape = "bar" | "block" | "circle";

const SHAPE: Record<Shape, string> = { bar: "h-2 rounded-full", block: "h-ctl-sm rounded-md", circle: "size-4 rounded-full" };

/**
 * The shape of something that is loading (decisions 76 and 77): a muted fill, static. It pulses only when `shimmer` is set,
 * which a view does only while its request is in flight; a skeleton on an idle screen never animates. Always `aria-hidden`:
 * the busy region carries `aria-busy`.
 *
 * - `shape`: `bar` (a text line, 8px), `block` (a 28px slab: an image, a tool row), `circle` (an avatar or glyph).
 * - `width`: a CSS length or percentage (measured, so an inline style); `className` for `h-*` overrides in layout only.
 *
 * Not for: a spinner on a button (`Button loading`), a progress meter, an empty state.
 */
export function Skeleton({
  shape = "bar",
  width,
  shimmer = false,
  className,
}: {
  shape?: Shape;
  width?: string | number;
  shimmer?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn("octo-skeleton block shrink-0", SHAPE[shape], className)}
      {...(shimmer ? { "data-shimmer": "" } : {})}
      {...(width === undefined ? {} : { style: { width } })}
    />
  );
}

/** Several text lines; the last is shorter. */
export function SkeletonText({ lines = 3, shimmer = false, className }: { lines?: number; shimmer?: boolean; className?: string }) {
  return (
    <div aria-hidden className={cn("flex flex-col gap-2", className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} shimmer={shimmer} width={i === lines - 1 && lines > 1 ? "60%" : "100%"} />
      ))}
    </div>
  );
}

const DEFAULT_WIDTHS = [64, 48, 72, 40];

/**
 * Placeholder rows with the height of a `ListRow` of the same `size` (28/32/40), so the list does not jump when the data
 * arrives. `twoLine` draws a title and a shorter dim line; `leading` reserves the 16px slot.
 */
export function SkeletonList(props: {
  count: number;
  size?: ControlSize;
  twoLine?: boolean;
  leading?: boolean;
  shimmer?: boolean;
  widths?: number[];
  className?: string;
}) {
  const widths = props.widths ?? DEFAULT_WIDTHS;
  const size = props.size ?? "sm";
  return (
    <div aria-hidden className={cn("flex flex-col", props.className)}>
      {Array.from({ length: props.count }, (_, i) => (
        <div key={i} className={cn("flex items-center gap-2 px-2", props.twoLine ? "min-h-ctl-lg py-1" : CONTROL[size].h)}>
          {props.leading !== false && <span className="size-4 shrink-0" />}
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton shimmer={props.shimmer ?? false} width={`${widths[i % widths.length] ?? 100}%`} />
            {props.twoLine && <Skeleton shimmer={props.shimmer ?? false} width={`${(widths[(i + 1) % widths.length] ?? 60) * 0.7}%`} />}
          </span>
        </div>
      ))}
    </div>
  );
}
