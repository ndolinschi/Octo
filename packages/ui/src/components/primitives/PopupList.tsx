import { useScrollFade } from "../../lib/hooks";
import { useId, useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import type { PickerRow, PickerSection } from "../../lib/picker";
import { Highlight } from "./Highlight";
import { createPointerGate } from "./popupNav";

/** Rows visible before the list scrolls. */
const VISIBLE = 9;
/**
 * The list's height: whole rows of the row token in force (28px, 40px under `touch:`) plus the list's 4px padding top and
 * bottom. Computed by CSS from the same tokens as the rows' `h-row` / `touch:h-ctl-lg`, so a narrow window shows whole rows.
 */
const MAX_HEIGHT = "max-h-[calc(var(--spacing-row)*var(--popup-rows)+8px)] touch:max-h-[calc(var(--spacing-ctl-lg)*var(--popup-rows)+8px)]";

/**
 * `tall` (audit B4): up to 480px, but never past the window, still whole rows (CSS `round`). 88px is the popover's margins
 * and its search field; a footer or a note takes its room from the list, which shrinks inside the popover (min-h-0). It was
 * 160px: at a short window (200 % zoom, ~400px tall) the list stopped at 3 rows with the window's height unused.
 */
const TALL_HEIGHT =
  "max-h-[calc(round(down,min(480px,100vh-88px)-8px,var(--spacing-row))+8px)] touch:max-h-[calc(round(down,min(480px,100vh-88px)-8px,var(--spacing-ctl-lg))+8px)]";

/** The panel look of every popup list that floats on its own (slash and mention menus; the pickers get it from `Popover`). */
export const POPUP_PANEL =
  "octo-overlay fixed z-[60] flex flex-col overflow-hidden rounded-xl bg-overlay text-sm shadow-pop forced-colors:border forced-colors:border-[CanvasText] [--octo-origin:0%_100%]";

/** The DOM id of a row's option, for `aria-activedescendant` (the owner of the keys sets it on its input). */
export function popupOptionId(listId: string, rowId: string): string {
  return `${listId}-o-${rowId.replace(/[^\w-]/g, "_")}`;
}

/**
 * The one list of every popup (decision 95): the composer's slash and mention menus, the model, folder and routing pickers.
 * Same rows (28px, 40px with a `sub` line or under `touch:`; 16px lead slot, name with the match highlighted, dim detail, right-aligned hint),
 * same group captions, same empty line, same keyboard contract.
 *
 * It does not own the keys: the field that keeps focus (a search input, or the composer's text) calls `popupTarget`
 * (`./popupNav`) and passes the result as `activeId`. The list only shows it: the active row is scrolled into view whenever
 * it changes by anything but the pointer, and a pointer that rests over the list never takes the active row (`createPointerGate`).
 *
 * - `sections`: captions (an empty `title` has none) over rows; disabled rows are shown dim and are never active.
 * - `hintOnActive`: the hint shows only on the active row (its slot stays reserved).
 *
 * Not for: a context menu of actions with focus on its items (`Menu`), a choice from a short list without a field (`Select`).
 */
export function PopupList(props: {
  sections: readonly PickerSection[];
  activeId: string | null;
  onActive(id: string): void;
  onChoose(row: PickerRow): void;
  label: string;
  /** Id of the listbox (`aria-controls` of the field); defaults to a generated one. */
  id?: string;
  query?: string;
  /** The line shown when no row is left. */
  empty?: ReactNode;
  hintOnActive?: boolean;
  maxRows?: number;
  /** A tall list (the model picker): grows with the window up to 480px instead of `maxRows`, its scrolling ends fade (12px). */
  tall?: boolean;
  /** The row's `detail` is a short tag ("experimental", "default"): a pill that never shrinks; the name keeps its room too, so a long hint goes to the second line (`sub`). */
  tagDetail?: boolean;
  /** Keys that reach the list itself (focus normally stays in the field; a click may have put it here). */
  onKeyDown?(e: KeyboardEvent<HTMLDivElement>): void;
  className?: string;
}) {
  const own = useId();
  const listId = props.id ?? own;
  const list = useRef<HTMLDivElement>(null);
  const fromPointer = useRef<string | null>(null);
  const gate = useRef(createPointerGate());
  useScrollFade(list, "y");
  const { activeId, query = "" } = props;
  const hasLead = props.sections.some((s) => s.rows.some((r) => r.lead !== undefined));
  const count = props.sections.reduce((n, s) => n + s.rows.length, 0);

  useLayoutEffect(() => {
    if (activeId === null) return;
    if (fromPointer.current === activeId) {
      fromPointer.current = null;
      return;
    }
    const box = list.current;
    const item = box?.querySelector<HTMLElement>(`#${CSS.escape(popupOptionId(listId, activeId))}`);
    if (!box || !item) return;
    const br = box.getBoundingClientRect();
    const ir = item.getBoundingClientRect();
    if (ir.top < br.top) box.scrollTop -= br.top - ir.top;
    else if (ir.bottom > br.bottom) box.scrollTop += ir.bottom - br.bottom;
  }, [activeId, listId]);

  return (
    <div
      ref={list}
      id={listId}
      role="listbox"
      aria-label={props.label}
      tabIndex={-1}
      onKeyDown={props.onKeyDown}
      // The field keeps focus: a press on a row must not take it.
      onMouseDown={(e) => {
        if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
      }}
      onClick={(e) => {
        const el = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-picker-row]") : null;
        if (!el || (e.target instanceof Element && e.target.closest("button"))) return;
        const row = props.sections.flatMap((s) => s.rows).find((r) => r.id === el.dataset.pickerRow);
        if (row && !row.disabled) props.onChoose(row);
      }}
      className={cn("min-h-0 overflow-y-auto overscroll-contain p-1", props.tall ? cn(TALL_HEIGHT, "octo-popup-fade") : MAX_HEIGHT, props.className)}
      style={{ "--popup-rows": props.maxRows ?? VISIBLE } as CSSProperties}
    >
      {props.sections.map((s) =>
        s.rows.length === 0 ? null : (
          <div
            key={s.title || "rows"}
            role="group"
            {...(s.title ? { "aria-labelledby": `${listId}-g-${s.title.replace(/\W/g, "_")}` } : { "aria-label": props.label })}
          >
            {s.title && (
              <div id={`${listId}-g-${s.title.replace(/\W/g, "_")}`} className="flex h-row items-center px-2 text-xs text-fg-3">
                {s.title}
              </div>
            )}
            {s.rows.map((r) => {
              const on = activeId === r.id;
              const sub = on ? "text-fg-2" : "text-fg-3";
              return (
                <div
                  key={r.id}
                  id={popupOptionId(listId, r.id)}
                  role="option"
                  aria-selected={on}
                  aria-disabled={r.disabled || undefined}
                  aria-checked={r.checked}
                  aria-busy={r.busy || undefined}
                  title={r.title}
                  data-picker-row={r.id}
                  onPointerMove={(e) => {
                    if (!gate.current(e) || r.disabled || on) return;
                    fromPointer.current = r.id;
                    props.onActive(r.id);
                  }}
                  className={cn(
                    "group flex min-w-0 items-center gap-2 rounded-md px-2 press-row touch:h-ctl-lg",
                    r.sub ? "h-10" : "h-row",
                    r.disabled ? "text-fg-3" : on ? "bg-active text-fg" : "text-fg hover:bg-hover/50",
                  )}
                >
                  {hasLead && (
                    <span aria-hidden className="grid size-4 shrink-0 place-items-center text-fg-3">
                      {r.lead}
                    </span>
                  )}
                  {r.content !== undefined ? (
                    r.content
                  ) : (
                    <span className="flex min-w-0 flex-1 flex-col">
                      {/* The name keeps its room: the tag, the detail and the hint give way first (decision 64 f); it truncates only when it alone is wider than the row. */}
                      <span className="flex min-w-0 items-center gap-2">
                        <span className={cn("max-w-full min-w-0 shrink-0 truncate", r.quiet && !on && "text-fg-2")}>
                          <Highlight text={r.label} query={query} />
                        </span>
                        {r.checked && <span className="sr-only">(current)</span>}
                        {r.detail &&
                          (r.pathDetail ? (
                            <span className="min-w-0 flex-1 truncate text-xs text-fg-3" dir="rtl">
                              {/* RTL truncation keeps the end of the path visible. */}
                              <bdi>{r.detail}</bdi>
                            </span>
                          ) : props.tagDetail ? (
                            <span className="shrink-0 rounded-xs bg-hover px-1.5 text-xs text-fg-3">{r.detail}</span>
                          ) : (
                            // On the active row the muted detail steps up to fg-2 (fg-3 over the active fill measured 4.06:1).
                            <span className={cn("min-w-0 flex-1 shrink-[10] truncate text-xs", sub)}>{r.detail}</span>
                          ))}
                        <span className="ml-auto flex min-w-0 shrink-[10] items-center gap-1 pl-1">
                          {r.hint && (
                            <span
                              aria-hidden={props.hintOnActive ? !on : undefined}
                              className={cn("min-w-0 truncate text-xs", sub, props.hintOnActive && !on && "invisible")}
                            >
                              {r.hint}
                            </span>
                          )}
                          {r.checked && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-fg-2" />}
                        </span>
                      </span>
                      {r.sub && <span className={cn("min-w-0 truncate text-xs", sub)}>{r.sub}</span>}
                    </span>
                  )}
                  {r.trailing}
                </div>
              );
            })}
          </div>
        ),
      )}
      {count === 0 && <div className="flex min-h-row items-center gap-2 px-2 text-xs text-fg-3">{props.empty ?? "Nothing matches"}</div>}
    </div>
  );
}
