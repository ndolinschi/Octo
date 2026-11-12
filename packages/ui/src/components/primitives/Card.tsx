import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

type Surface = "raised" | "panel" | "code";
type Padding = "none" | "sm" | "md" | "lg";

const SURFACE: Record<Surface, string> = { raised: "bg-raised", panel: "bg-panel", code: "bg-code-bg" };
const PAD: Record<Padding, string> = { none: "", sm: "p-2", md: "p-card", lg: "p-4" };
const SLOT_PAD: Record<Padding, string> = { none: "px-card", sm: "px-2", md: "px-card", lg: "px-4" };

/**
 * The one bordered frame (decision 90): 8px radius, a hairline `line` border, one of three surfaces. It never takes a tone
 * border (decision 81: no warning, danger or accent frames; the state is a glyph and text inside it).
 *
 * - `surface`: `raised` (default, on a panel), `panel` (on the window), `code` (a recessed block: commands, images).
 * - `padding`: none, sm 8, md 12 (`--spacing-card`, default), lg 16.
 * - `header` / `footer`: slots in 32px bands separated by a hairline; the body keeps `padding`.
 * - `as`: `section`, `li` or `div`.
 *
 * Not for: a card inside a card (decision 64c: use spacing), a divided list of rows (`ListFrame`), a message (`Notice`),
 * an overlay (`Popover`, `Dialog`).
 */
export function Card(props: {
  surface?: Surface;
  padding?: Padding;
  header?: ReactNode;
  footer?: ReactNode;
  as?: "div" | "section" | "li";
  className?: string;
  children?: ReactNode;
}) {
  const { surface = "raised", padding = "md", as: Tag = "div" } = props;
  return (
    <Tag className={cn("flex min-w-0 flex-col overflow-hidden rounded-md border border-line", SURFACE[surface], props.className)}>
      {props.header && (
        <div className={cn("flex min-h-ctl-md shrink-0 items-center gap-2 border-b border-line text-sm", SLOT_PAD[padding])}>{props.header}</div>
      )}
      <div className={cn("min-w-0 flex-1", PAD[padding])}>{props.children}</div>
      {props.footer && (
        <div className={cn("flex min-h-ctl-md shrink-0 items-center gap-2 border-t border-line text-sm", SLOT_PAD[padding])}>{props.footer}</div>
      )}
    </Tag>
  );
}

/**
 * The grouped-list frame (settings groups, provider lists): panel surface, 10px radius, `panel-edge` hairline, hairlines
 * between its children. Children are rows (`ListRow`, a settings row) that bring their own padding.
 *
 * Not for: loose content (`Card`).
 */
export function ListFrame(props: { as?: "div" | "ul"; className?: string; children: ReactNode }) {
  const Tag = props.as ?? "div";
  return (
    <Tag className={cn("flex flex-col divide-y divide-line overflow-hidden rounded-lg border border-panel-edge bg-panel shadow-panel", props.className)}>
      {props.children}
    </Tag>
  );
}
