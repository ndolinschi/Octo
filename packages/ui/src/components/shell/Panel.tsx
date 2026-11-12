import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

/**
 * A panel: a card lighter than the near-black window (conversation, side groups), radius 12 with a faint
 * edge and a 1px inner top highlight. Its content keeps the `pane` inset (8px) on every side. Full-bleed
 * without edge, radius or highlight on phone widths, where the gutters would only waste space.
 *
 * Decision 79 — a pane's width comes from the layout state, never from its content: `contain-inline-size` gives the
 * panel no intrinsic width at any flex or grid level above it, and `overflow-clip` (unlike `overflow-hidden`) is not a
 * scroll container, so nothing inside — a focused input at the end of a 400-column line, a scrollIntoView — can scroll
 * the panel sideways and shift the pane.
 */
export const panelClass =
  "flex min-h-0 min-w-0 flex-col overflow-clip contain-inline-size rounded-xl border border-panel-edge bg-panel shadow-panel max-sm:rounded-none max-sm:border-0 max-sm:shadow-none";

export function Panel({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div data-panel className={cn(panelClass, className)} {...rest} />;
}
