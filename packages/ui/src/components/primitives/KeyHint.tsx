import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * A keyboard shortcut mark (decision 90; merges `v7/parts` `Kbd` and `review/parts` `Key`, which were byte-identical): a
 * 16px hairline box, 12px mono text in the current colour at 70% opacity. Decorative (`aria-hidden`): the shortcut also
 * belongs in the control's accessible name or `aria-keyshortcuts`. Hidden below the `sm` breakpoint (no keyboard) unless
 * `always`. One key per hint; a chord is several hints.
 *
 * Not for: the tooltip of an icon button (`IconButton shortcut`), the shortcut column of a menu (`Menu` item `shortcut`).
 */
export function KeyHint({ children, always = false, className }: { children: ReactNode; always?: boolean; className?: string }) {
  return (
    <kbd aria-hidden className={cn("octo-keyhint shrink-0", !always && "max-sm:hidden", className)}>
      {children}
    </kbd>
  );
}

/** The old names, so the two feature-local copies can be swapped for an import without a rename. */
export const Kbd = KeyHint;
export const Key = KeyHint;
