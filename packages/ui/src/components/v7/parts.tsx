import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { diffBlocks } from "../../lib/v7/approval";

/**
 * The one frame of the v7 cards (decision 43: forms and approvals share it): a bordered card in the conversation's
 * column, 12px inside, with the neutral border of any card (decision 81: waiting for the person is said by position, the
 * state glyph and the primary button, never by a coloured edge).
 */
/** A stable callback ref: focuses the element when it mounts (no `autoFocus` attribute, which skips the focus ring logic). */
export function focusOnMount(el: HTMLElement | null): void {
  el?.focus();
}

export const CardFrame = forwardRef<HTMLElement, HTMLAttributes<HTMLElement>>(function CardFrame({ className, children, ...rest }, ref) {
  return (
    <section ref={ref} className={cn("@container/v7 min-w-0 rounded-md border border-line bg-panel text-sm", className)} {...rest}>
      {children}
    </section>
  );
});

/** A key hint inside a button ("A", "D"); hidden from assistive tech (the button has `aria-keyshortcuts`). */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd aria-hidden data-key-hint className="octo-v7-kbd max-sm:hidden">
      {children}
    </kbd>
  );
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

/** An inline error with its next step (rule 20); `role=alert` so it is announced when it appears. */
export function ErrorLine({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p role="alert" className={cn("text-xs text-err", className)}>
      {children}
    </p>
  );
}
