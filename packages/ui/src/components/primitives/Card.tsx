import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/cn";

type Surface = "raised" | "panel" | "code";
type Padding = "none" | "sm" | "md" | "lg";

/**
 * Polish trial T3 ("one outline per level"): the panel keeps its edge; a card on it is told apart by tone alone, one step up
 * (`raised`), with no outline. `panel` is kept as a name for the old callers and now means the same as `raised` (a panel-tone
 * card inside a panel needed an outline to be seen at all). `code` is a recessed block. Inside a raised card a code block takes
 * the panel's tone (`octo-in-card` in styles.css), so a block in a card is a tone, never an outline of its own.
 */
const SURFACE: Record<Surface, string> = { raised: "octo-in-card bg-raised", panel: "octo-in-card bg-raised", code: "bg-code-bg" };
const PAD: Record<Padding, string> = { none: "", sm: "p-2", md: "p-card", lg: "p-4" };
const SLOT_PAD: Record<Padding, string> = { none: "px-card", sm: "px-2", md: "px-card", lg: "px-4" };

/**
 * The one card (decision 90): 8px radius, a surface one tone above what it sits on and no border (polish trial T3). It never
 * takes a tone border (decision 81: no warning, danger or accent frames; the state is a glyph and text inside it).
 *
 * - `surface`: `raised` (default, on a panel), `panel` (deprecated alias of `raised`), `code` (a recessed block: commands, images).
 * - `padding`: none, sm 8, md 12 (`--spacing-card`, default), lg 16.
 * - `header` / `footer`: slots in 32px bands separated by a hairline; the body keeps `padding`.
 * - `as`: `section`, `li` or `div`. `ref`, `aria-*`, `data-*`, `id`, `tabIndex`, `role` and event handlers pass through to the frame.
 *
 * Not for: a card inside a card (decision 64c: use spacing), a divided list of rows (`ListFrame`), a message (`Notice`),
 * an overlay (`Popover`, `Dialog`).
 */
export const Card = forwardRef<
  HTMLElement,
  Omit<HTMLAttributes<HTMLElement>, "title" | "className" | "children"> & {
    surface?: Surface;
    padding?: Padding;
    header?: ReactNode;
    footer?: ReactNode;
    as?: "div" | "section" | "li";
    className?: string;
    children?: ReactNode;
  }
>(function Card(props, ref) {
  const { surface = "raised", padding = "md", as: Tag = "div", header, footer, className, children, ...rest } = props;
  return (
    <Tag
      // `ref`, `aria-*`, `data-*`, `tabIndex`, `role` and key handlers go to the frame itself: no wrapper element is needed.
      ref={ref as never}
      className={cn("flex min-w-0 flex-col overflow-hidden rounded-md", SURFACE[surface], className)}
      {...rest}
    >
      {header && <div className={cn("flex min-h-ctl-md shrink-0 items-center gap-2 border-b border-line text-sm", SLOT_PAD[padding])}>{header}</div>}
      <div className={cn("min-w-0 flex-1", PAD[padding])}>{children}</div>
      {footer && <div className={cn("flex min-h-ctl-md shrink-0 items-center gap-2 border-t border-line text-sm", SLOT_PAD[padding])}>{footer}</div>}
    </Tag>
  );
});

/**
 * The grouped-list frame (settings groups, provider lists): panel surface, 12px radius, `panel-edge` hairline (an overlay that takes no room at the sides: a row's padding is measured from the frame's edge), hairlines
 * between its children. Children are rows (`ListRow`, a settings row) that bring their own padding.
 *
 * Not for: loose content (`Card`).
 */
export function ListFrame(props: { as?: "div" | "ul"; className?: string; children: ReactNode }) {
  const Tag = props.as ?? "div";
  return (
    <Tag
      className={cn(
        // The edge is an overlay (`after`) and row hairlines are inset shadows, so borders never shrink padding at the sides or fixed row heights (ListRow).
        "relative flex flex-col overflow-hidden rounded-xl border-y border-transparent bg-panel shadow-panel after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:border after:border-panel-edge [&>*]:rounded-none [&>*:not(:last-child)]:shadow-[inset_0_-1px_0_var(--octo-line)]",
        props.className,
      )}
    >
      {props.children}
    </Tag>
  );
}
