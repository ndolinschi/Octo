import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * The one section heading (decision 90; the audit found six styles).
 *
 * - `level="caption"` (default): `text-xs` in `fg-3` on a 28px line: the label over a list or a settings group.
 * - `level="title"`: `text-heading` (14px, semibold) in `fg`: the title of a dialog body, a detail pane, a card.
 * - `aside`: right-aligned node on the same line (a count, a quiet button).
 * - `inset`: 8px side padding so the text lines up with the labels of `ListRow`s below it.
 * - `as`: the heading element (`h2` default); the look does not depend on it.
 *
 * Not for: a page title (`text-display` in the page itself), a dialog title (`Dialog` has its own), a table header.
 */
export function SectionHeader(props: {
  children: ReactNode;
  level?: "caption" | "title";
  aside?: ReactNode;
  inset?: boolean;
  as?: "h2" | "h3" | "h4";
  id?: string;
  className?: string;
}) {
  const Heading = props.as ?? "h2";
  const title = props.level === "title";
  return (
    <div className={cn("flex min-h-ctl-sm items-center gap-2", props.inset && "px-2", title ? "text-heading text-fg" : "text-xs text-fg-3", props.className)}>
      <Heading id={props.id} className="min-w-0 flex-1 truncate">
        {props.children}
      </Heading>
      {props.aside}
    </div>
  );
}
