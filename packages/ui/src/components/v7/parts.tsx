import { cn } from "../../lib/cn";
import { diffBlocks } from "../../lib/v7/approval";

/** A stable callback ref: focuses the element when it mounts (no `autoFocus` attribute, which skips the focus ring logic). */
export function focusOnMount(el: HTMLElement | null): void {
  el?.focus();
}

/** `+12 −3` in tabular figures, ok / err tones; nothing for an unknown count. */
export function LineCounts({ added, removed, className }: { added: number | null; removed: number | null; className?: string }) {
  if (added === null && removed === null) return null;
  return (
    <span className={cn("inline-flex shrink-0 gap-1.5 text-xs tabular-nums", className)}>
      {added !== null && <span className="text-ok">+{added}</span>}
      {removed !== null && <span className="text-err">−{removed}</span>}
    </span>
  );
}

/** Five small blocks with the share of added and removed lines (a diffstat bar). */
export function DiffBar({ added, removed }: { added: number; removed: number }) {
  return (
    <span aria-hidden className="inline-flex shrink-0 gap-0.5">
      {diffBlocks(added, removed).map((b, i) => (
        <span key={i} className={cn("size-2 rounded-2xs", b === "add" ? "bg-ok" : b === "del" ? "bg-err" : "bg-active")} />
      ))}
    </span>
  );
}
