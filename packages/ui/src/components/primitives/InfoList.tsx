import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * Overview lists (Details tab, Home cards): a 12px `fg-3` caption on a 28px line, then 28px rows on a
 * 4px list inset (selected-row shape: radius 6, 8px side padding). Rows are [16 slot] 8 [label] … [value].
 */
export const INFO_ROW = "flex h-row min-w-0 items-center gap-2 rounded-sm px-2 text-sm";
/** An actionable info row (opens something). */
export const INFO_ROW_BUTTON = cn(INFO_ROW, "w-full text-left press-row focus-inset hover:bg-hover");

export function InfoSection(props: { title: string; aside?: ReactNode; children: ReactNode; className?: string; labelId?: string }) {
  return (
    <section aria-labelledby={props.labelId} className={cn("flex flex-col", props.className)}>
      <div className="flex h-row items-center gap-2 px-2 text-xs text-fg-3">
        <h3 id={props.labelId} className="min-w-0 flex-1 truncate">
          {props.title}
        </h3>
        {props.aside}
      </div>
      {props.children}
    </section>
  );
}

/** A quiet 28px "Show all" / "Show more" row, aligned with the rows' labels (`slot` when they lead with a glyph). */
export function MoreRow(props: { label: string; onClick(): void; expanded?: boolean; slot?: boolean }) {
  return (
    <button type="button" aria-expanded={props.expanded} onClick={props.onClick} className={cn(INFO_ROW_BUTTON, "text-fg-3 hover:text-fg")}>
      {props.slot && <span aria-hidden className="size-4 shrink-0" />}
      <span>{props.label}</span>
    </button>
  );
}

/** Placeholder rows while data loads (no text, no layout jump: same row height as the content). */
export function SkeletonRows({ count, widths = [64, 48, 72, 40] }: { count: number; widths?: number[] }) {
  return (
    <div aria-hidden className="flex flex-col">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={INFO_ROW}>
          <span className="size-4 shrink-0" />
          <span className="h-2 rounded-full bg-hover" style={{ width: `${widths[i % widths.length]}%` }} />
        </div>
      ))}
    </div>
  );
}
