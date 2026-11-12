import type { AriaRole, MouseEventHandler, ReactNode } from "react";
import { cn } from "../../lib/cn";
import { rowHeight, selectionAria, type RowSize } from "../../lib/listRow";
import { MiddleText } from "./MiddleText";

/**
 * A row of any list (decision 90): sidebar and settings nav, file and pull-request lists, pickers, tool rows, memory and
 * queue lists. Replaces `INFO_ROW_BUTTON`, memory's `ListRow`, `FileRow`, `PullRow`, `NavRow` and the 21 hand-written
 * `press-row` buttons.
 *
 * Anatomy, left to right: `control` (a checkbox or other real control, outside the row's button), `leading` (a 16px slot:
 * glyph, state ring), the text (`title`, and under it a dim `description`), `meta` (right-aligned dim text: a time, a count,
 * a shortcut), `trailing` (row actions: quiet `IconButton`s that appear on hover or focus-within and on touch; they always
 * occupy their width, so the row never reflows).
 *
 * - `size`: sm 28 (default), md 32, lg 40. A `description` makes the row two lines (at least 40px). Touch: at least 40px.
 * - Interactive when it has `onClick` (a button) or `href` (a link); otherwise a static row. Roving focus: the main element
 *   carries `data-row`, so `useRowKeys` / `moveInList` work on the list; a listbox passes `role="option"` and `active`.
 * - `selected` is the standard selection (`active` fill; `aria-current`, or `aria-selected` for an option). `active` is the
 *   active-descendant highlight of a combobox list (same fill, no ARIA state: the listbox owns it).
 * - Truncation: the title has priority and gives way last; `truncate="middle"` keeps the end of a path or id; the meta and
 *   description give way first.
 * - `tone`: `default` (`fg`) or `quiet` (`fg-2`, secondary lists).
 *
 * Not for: a table (`DataTable`), a menu item (`Menu`), a tab (`ViewTabs`), a settings row with a control on the right
 * (the settings row composes `ListFrame`).
 */
export function ListRow(props: {
  title: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  leading?: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  size?: RowSize;
  selected?: boolean;
  active?: boolean;
  disabled?: boolean;
  truncate?: "end" | "middle";
  tone?: "default" | "quiet";
  onClick?: MouseEventHandler<HTMLElement>;
  href?: string;
  role?: AriaRole;
  id?: string;
  /** Tooltip with the whole title. */
  tip?: string;
  className?: string;
}) {
  const { selected = false, active = false, disabled = false } = props;
  const twoLine = props.description !== undefined;
  const interactive = props.onClick !== undefined || props.href !== undefined;
  const aria = { ...selectionAria(props.role, selected), ...(disabled ? { "aria-disabled": true } : {}) };
  const main = cn(
    "flex h-full min-w-0 flex-1 items-center gap-2 rounded-sm px-2 text-left text-sm",
    interactive && "press-row focus-inset",
    disabled && "pointer-events-none",
  );
  const title =
    typeof props.title === "string" && props.truncate === "middle" ? (
      <MiddleText text={props.title} />
    ) : (
      <span className="min-w-0 truncate">{props.title}</span>
    );
  const body = (
    <>
      {props.leading !== undefined && (
        <span aria-hidden className="grid size-4 shrink-0 place-items-center text-fg-3">
          {props.leading}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          {title}
          {props.meta !== undefined && <span className="ml-auto min-w-0 shrink-[10] truncate pl-1 text-xs text-fg-3">{props.meta}</span>}
        </span>
        {twoLine && <span className="min-w-0 truncate text-xs text-fg-3">{props.description}</span>}
      </span>
    </>
  );
  return (
    <div
      className={cn(
        "group flex min-w-0 items-center rounded-sm",
        rowHeight(props.size ?? "sm", twoLine),
        selected || active ? "bg-active text-fg" : cn(props.tone === "quiet" ? "text-fg-2" : "text-fg", interactive && "hover:bg-hover"),
        disabled && "text-fg-3",
        props.className,
      )}
    >
      {props.control !== undefined && <span className="flex shrink-0 items-center pl-2">{props.control}</span>}
      {props.href !== undefined ? (
        <a id={props.id} href={props.href} role={props.role} data-row title={props.tip} onClick={props.onClick} className={main} {...aria}>
          {body}
        </a>
      ) : props.onClick !== undefined ? (
        <button id={props.id} type="button" role={props.role} data-row title={props.tip} disabled={disabled} onClick={props.onClick} className={main} {...aria}>
          {body}
        </button>
      ) : (
        <div id={props.id} role={props.role} title={props.tip} className={main} {...aria}>
          {body}
        </div>
      )}
      {props.trailing !== undefined && (
        <span className="flex shrink-0 items-center gap-0.5 pr-1 opacity-0 transition-opacity duration-100 group-focus-within:opacity-100 group-hover:opacity-100 touch:opacity-100">
          {props.trailing}
        </span>
      )}
    </div>
  );
}
