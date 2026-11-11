import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { barHeights } from "../../lib/usage";

export type DayBar = { key: string; value: number; /** The readout for this day ("Nov 3: 1.2M tokens, 900k in, 300k out"). */ text: string };

/** Gap between bars (px, on the scale). */
const GAP = 2;
/** A day with data is at least this tall, so a small day is still a bar and not a speck. */
const MIN_BAR = 3;

/**
 * A bar per day (Usage tab, Home's Tokens card): integer bar widths and heights (measured, so nothing is soft at
 * DPR 1), a square-root or log scale when one day dominates (`barHeights`), a 1px baseline under every day (a day without data is only the baseline), optional first / last date ticks. Pointer
 * hover and the keyboard (the chart is one tab stop; ←/→, Home/End) pick a day; its numbers show in the readout
 * line under the bars, which otherwise shows `summary`. It is a slider over the days for assistive tech (the value text is
 * the day's readout).
 */
export function DayBars({
  days,
  height,
  label,
  summary,
  ticks,
}: {
  days: DayBar[];
  height: number;
  label: string;
  summary: ReactNode;
  /** The first and last day's labels under the baseline (so a sparse chart still reads as a time axis). */
  ticks?: readonly [string, string];
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);
  const readout = useId();
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setWidth(Math.floor(el.clientWidth));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const n = days.length;
  const bar = n > 0 ? Math.max(1, Math.floor((width - GAP * (n - 1)) / n)) : 0;
  const { scale, heights } = barHeights(
    days.map((d) => d.value),
    height,
    MIN_BAR,
  );
  const shown = active !== null ? days[Math.min(active, n - 1)] : undefined;

  const onKeyDown = (e: KeyboardEvent) => {
    const at = active ?? n - 1;
    const next: Record<string, number> = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: n - 1 };
    const to = next[e.key];
    if (to === undefined) return;
    e.preventDefault();
    setActive(Math.max(0, Math.min(n - 1, to)));
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div
        ref={box}
        role="slider"
        tabIndex={0}
        aria-label={`${label}${scale === "linear" ? "" : ` (${scale === "sqrt" ? "square-root" : "logarithmic"} scale: one day is much larger than the rest)`}`}
        aria-valuemin={0}
        aria-valuemax={Math.max(0, n - 1)}
        aria-valuenow={active ?? n - 1}
        aria-valuetext={(days[active ?? n - 1] ?? days[n - 1])?.text ?? ""}
        data-scale={scale}
        onKeyDown={onKeyDown}
        onFocus={() => setActive((a) => a ?? n - 1)}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
        className="flex items-end rounded-xs"
        style={{ height, gap: GAP }}
      >
        {width > 0 &&
          days.map((d, i) => (
            <span
              key={d.key}
              aria-hidden
              data-day={d.key}
              onPointerEnter={() => setActive(i)}
              className="flex h-full shrink-0 items-end"
              style={{ width: bar }}
            >
              <span
                className={cn("block w-full rounded-t-2xs", i === active ? "bg-accent" : "bg-fg-3")}
                style={{ height: d.value > 0 ? (heights[i] ?? 0) : 0 }}
              />
            </span>
          ))}
      </div>
      {/* The baseline: the axis the bars stand on (days without data show only this). */}
      <span aria-hidden className="-mt-2 block h-px bg-line-strong" />
      {ticks && (
        <span aria-hidden className="-mt-1 flex h-4 items-center justify-between text-xs text-fg-3 tabular-nums">
          <span>{ticks[0]}</span>
          <span>{ticks[1]}</span>
        </span>
      )}
      <p id={readout} aria-live="polite" className="h-4 truncate text-xs text-fg-3 tabular-nums">
        {shown ? shown.text : summary}
      </p>
    </div>
  );
}
