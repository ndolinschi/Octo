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
  /**
   * `tight`: the caption rule of the side columns (sidebar, settings navigation) on a page: a 20px line, its `aside` laid
   * over the line (a 24px quiet button overhangs it by 2px each way) so the gap under the caption is the caller's alone.
   */
  line?: "tight";
  id?: string;
  className?: string;
}) {
  const Heading = props.as ?? "h2";
  const title = props.level === "title";
  const tight = props.line === "tight";
  return (
    <div
      className={cn(
        "flex items-center gap-2",
        tight ? "h-5 [&>*:not(h2,h3,h4)]:-my-0.5" : "min-h-ctl-sm",
        props.inset && "px-2",
        title ? "text-heading text-fg" : "text-xs text-fg-3",
        props.className,
      )}
    >
      <Heading id={props.id} className="min-w-0 flex-1 truncate">
        {props.children}
      </Heading>
      {props.aside}
    </div>
  );
}
