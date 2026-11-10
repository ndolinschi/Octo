import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

/**
 * An inset panel: the darker surface the window holds (conversation, side pane). Full-bleed
 * without border or radius on phone widths, where the margins would only waste space.
 */
export const panelClass =
  "flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-panel shadow-panel max-sm:rounded-none max-sm:border-0 max-sm:shadow-none";

export function Panel({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn(panelClass, className)} {...rest} />;
}
