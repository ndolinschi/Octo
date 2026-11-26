import { useId, type AriaAttributes, type AriaRole, type MouseEventHandler, type PointerEventHandler, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { emptyNode, nodeText, rowHeight, selectionAria, type RowSize } from "../../lib/listRow";
import { MiddleText } from "./MiddleText";

/**
 * A row of any list (decision 90): sidebar and settings nav, file and pull-request lists, pickers, tool rows, memory and
 * queue lists. Replaces `INFO_ROW_BUTTON`, memory's `ListRow`, `FileRow`, `PullRow`, `NavRow` and the 21 hand-written
 * `press-row` buttons.
 *
 * Anatomy, left to right: `control` (a checkbox or other real control, outside the row's button), `leading` (a 16px slot:
 * glyph, state ring), the text (`title`, and under it a dim `description`), `meta` (right-aligned dim text: a time, a count,
 * a shortcut), `trailing` (row actions: quiet `IconButton`s that appear on hover or focus-within and on touch). Hidden
 * actions take no width: they overlay the row's end on the row's fill (the list's surface, `--row-surface`, under the row's
 * tint) and the meta hides while they show, so a meta column lines up across rows; on touch they always show, in the flow.
 *
 * - `size`: sm 28 (default), md 32, lg 40. A `description` makes the row two lines (at least 40px). Touch: at least 40px.
 * - Interactive when it has `onClick` (a button) or `href` (a link); otherwise a static row. Roving focus: the main element
 *   carries `data-row`, so `useRowKeys` / `moveInList` work on the list; a listbox passes `role="option"` and `active`.
 * - `selected` is the standard selection (`active` fill; `aria-current`, or `aria-selected` for an option). `active` is the
 *   active-descendant highlight of a combobox list (same fill, no ARIA state: the listbox owns it). Hover is the `hover` tint,
 *   and half of it on an `option` row, so in a listbox the pointer's row never looks like the selected one (B58).
 * - Truncation: the title has priority and gives way last; `truncate="middle"` keeps the end of a path or id; the meta and
 *   description give way first. The meta never shrinks (a short time or count always shows whole) but stops at 40% of the
 *   row, where it clips with an ellipsis; a `metaYields` meta (a name) instead takes what the title leaves and gives way first.
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
  /**
   * The meta is a name (a session's project), not a time or a count: it takes the room the title leaves, past 40%, and gives
   * way first, down to 64px, so the title wins.
   */
  metaYields?: boolean;
  trailing?: ReactNode;
  /** The trailing actions show at all times, not on hover/focus (the one action a row needs: Retry on a failed row). */
  trailingShown?: boolean;
  size?: RowSize;
  selected?: boolean;
  active?: boolean;
  disabled?: boolean;
  /** A row that folds or unfolds something ("6 more", "Show fewer"): `aria-expanded`. */
  expanded?: boolean;
  /** A `treeitem`'s depth (`aria-level`): the sidebar's project (1) and session (2) rows. */
  level?: number;
  truncate?: "end" | "middle";
  tone?: "default" | "quiet";
  hover?: "row" | "text";
  onClick?: MouseEventHandler<HTMLElement>;
  onPointerMove?: PointerEventHandler<HTMLDivElement>;
  href?: string;
  role?: AriaRole;
  id?: string;
  /** Tooltip with the whole title. */
  tip?: string;
  className?: string;
  /** 6b: passed to the row's main element (a project row's `aria-haspopup="menu"`, a test hook). */
  "aria-haspopup"?: AriaAttributes["aria-haspopup"];
  "aria-describedby"?: string;
  [data: `data-${string}`]: string | number | boolean | undefined;
}) {
  const { selected = false, active = false, disabled = false } = props;
  const twoLine = props.description !== undefined;
  const interactive = props.onClick !== undefined || props.href !== undefined;
  const ids = useId();
  // 6c: a meta that draws nothing takes no room (the title then runs to the row's edge).
  const hasMeta = !emptyNode(props.meta);
  // Work-surface polish item 5: actions that show on hover or focus overlay the row's end instead of reserving their width.
  const overlay = props.trailing !== undefined && !props.trailingShown;
  const metaText = hasMeta ? nodeText(props.meta) : "";
  // 6a: the name is the title, then the leading slot's label (a state glyph's "Failed"), the description, the meta ("50m"),
  // in reading order, so a screen reader hears the state and the time the eye sees. The leading slot is no longer hidden
  // (its glyphs are `aria-hidden` themselves); the meta is read from its text, whatever the caller hid for its looks.
  const named = props.leading !== undefined || metaText !== "";
  const labelledBy = named
    ? [`${ids}t`, props.leading !== undefined && `${ids}l`, twoLine && `${ids}d`, metaText !== "" && `${ids}m`].filter(Boolean).join(" ")
    : undefined;
  const passed = Object.fromEntries(Object.entries(props).filter(([k]) => k.startsWith("data-") || k === "aria-haspopup" || k === "aria-describedby"));
  const aria = {
    ...passed,
    ...(labelledBy ? { "aria-labelledby": labelledBy } : {}),
    ...selectionAria(props.role, selected),
    ...(disabled ? { "aria-disabled": true } : {}),
    ...(props.expanded === undefined ? {} : { "aria-expanded": props.expanded }),
    ...(props.level === undefined ? {} : { "aria-level": props.level }),
  };
  const main = cn(
    "flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-[inherit] px-2 text-left text-sm",
    interactive && "press-row focus-inset",
    disabled && "pointer-events-none",
  );
  const title =
    typeof props.title === "string" && props.truncate === "middle" ? (
      <span id={`${ids}t`} className={cn("flex min-w-0", !props.metaYields && "flex-1")}>
        <MiddleText text={props.title} />
      </span>
    ) : (
      <span id={`${ids}t`} className={cn("min-w-0 truncate", !props.metaYields && "flex-1")}>
        {props.title}
      </span>
    );
  const body = (
    <>
      {props.leading !== undefined && (
        <span id={`${ids}l`} className="grid size-4 shrink-0 place-items-center text-fg-3">
          {props.leading}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        {/* `metaYields` (styles.css, `[data-meta-yields]`): the title keeps its width up to what leaves the meta 64px and the
            gap, the meta takes the rest and ends on the row's edge. In CSS to keep the entry chunk small. */}
        <span data-meta-yields={(props.metaYields && hasMeta) || undefined} className="flex min-w-0 items-center gap-2">
          {title}
          {hasMeta && (
            <span
              aria-hidden={metaText !== "" || undefined}
              data-row-tail
              className={cn(
                "ml-auto truncate pl-1 text-xs tabular-nums",
                !props.metaYields && "max-w-[40%] shrink-0",
                selected || active ? "text-fg-2" : "text-fg-3",
              )}
            >
              {props.meta}
            </span>
          )}
          {metaText !== "" && (
            <span id={`${ids}m`} className="sr-only">
              {metaText}
            </span>
          )}
        </span>
        {twoLine && (
          <span id={`${ids}d`} className={cn("min-w-0 truncate text-xs", selected || active ? "text-fg-2" : "text-fg-3")}>
            {props.description}
          </span>
        )}
      </span>
    </>
  );
  return (
    <div
      onPointerMove={props.onPointerMove}
      className={cn(
        "group flex min-w-0 items-center rounded-sm transition-colors duration-fast",
        rowHeight(props.size ?? "sm", twoLine),
        // styles.css, "row actions": the overlay, its fill and the tails (meta, `data-row-tail`) that give way to it.
        overlay && "octo-row-host",
        selected || active
          ? // 6d: forced colours drop the fill; the selection keeps a system-coloured edge there.
            "bg-active text-fg forced-colors:outline-2 forced-colors:-outline-offset-2 forced-colors:outline-[Highlight] forced-colors:outline-solid"
          : // B58 (polish step 2): in a listbox the keyboard's row and the pointer's row are both shown at once, so the pointer's
            // tint is half the hover tint there and never reads as a second selection.
            cn(
              props.tone === "quiet" ? "text-fg-2" : "text-fg",
              !disabled &&
                interactive &&
                (props.hover === "text"
                  ? props.tone === "quiet"
                    ? "hover:text-fg"
                    : "hover:text-fg-2"
                  : props.role === "option"
                    ? "hover:bg-hover/50"
                    : "hover:bg-hover"),
            ),
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
        <span className={cn("flex shrink-0 items-center gap-0.5 pr-1", !props.trailingShown && "octo-row-actions")}>{props.trailing}</span>
      )}
    </div>
  );
}
