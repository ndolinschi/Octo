import { Search, Star } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { cn } from "../../lib/cn";
import { MOD_LABEL } from "../../lib/keys";
import { pickerIndex, type PickerSection } from "../../lib/picker";
import { Glyph } from "./Glyph";
import { Highlight } from "./Highlight";
import { Popover } from "./Popover";

export type { PickerRow, PickerSection } from "../../lib/picker";

/** Rows visible before the list scrolls (28px each). */
const VISIBLE = 10;
const ROW = 28;

/**
 * A searchable quick picker anchored to a control (decisions 25 and 27): a search field on top, then sections of
 * 28px rows (leading glyph, name with the match highlighted, muted detail, an optional star and a right-aligned hint).
 * The field keeps focus: ↑/↓ move the active row (disabled rows are skipped), Enter runs it, `Ctrl/Cmd+1…9` runs the
 * nth enabled row (`digits`), `Ctrl/Cmd+D` toggles the active row's star; Esc or a click outside closes and focus
 * returns to the opener (the `Popover`). `sections` is computed by the caller from the query.
 */
export function Picker(props: {
  anchor: RefObject<HTMLElement | null>;
  label: string;
  placeholder: string;
  sections(query: string): PickerSection[];
  onClose(): void;
  side?: "top" | "bottom";
  align?: "start" | "end";
  /** Show `Ctrl/Cmd+1…9` on the first nine enabled rows and accept those keys. */
  digits?: boolean;
  /** Under the list, after a hairline (the model picker's Routing row). */
  footer?: ReactNode;
  empty?: string;
  /** Open above / below this element instead of the anchor (the whole composer, not its context bar). */
  edge?: () => HTMLElement | null;
}) {
  const { onClose } = props;
  const [query, setQuery] = useState("");
  const sections = props.sections(query);
  const flat = useMemo(() => sections.flatMap((s) => s.rows), [sections]);
  const enabled = flat.filter((r) => !r.disabled);
  const [active, setActive] = useState<string | null>(null);
  const current = enabled.find((r) => r.id === active) ?? enabled[0] ?? null;
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const optionId = (id: string) => `${baseId}-o-${id.replace(/[^\w-]/g, "_")}`;

  useEffect(() => {
    if (current) list.current?.querySelector(`#${CSS.escape(optionId(current.id))}`)?.scrollIntoView({ block: "nearest" });
  });

  const run = (id: string | undefined) => {
    const row = flat.find((r) => r.id === id);
    if (!row || row.disabled) return;
    onClose();
    row.run();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const at = current ? enabled.indexOf(current) : -1;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = pickerIndex(at, enabled.length, e.key === "ArrowDown" ? 1 : -1);
      setActive(enabled[next]?.id ?? null);
      return;
    }
    if (e.key === "Home" && mod) return void setActive(enabled[0]?.id ?? null);
    if (e.key === "End" && mod) return void setActive(enabled.at(-1)?.id ?? null);
    if (e.key === "Enter") {
      e.preventDefault();
      run(current?.id);
      return;
    }
    if (mod && !e.altKey && props.digits && /^Digit[1-9]$/.test(e.code)) {
      e.preventDefault();
      e.stopPropagation();
      run(enabled[Number(e.code.slice(5)) - 1]?.id);
      return;
    }
    if (mod && !e.altKey && e.key.toLowerCase() === "d" && current?.star) {
      e.preventDefault();
      current.star.toggle();
    }
  };

  // Ctrl/Cmd+1…9 number the first nine enabled rows.
  const digitOf = new Map(enabled.slice(0, 9).map((r, i) => [r.id, i + 1]));
  return (
    <Popover
      anchor={props.anchor}
      label={props.label}
      onClose={onClose}
      {...(props.edge ? { edge: props.edge } : {})}
      side={props.side ?? "bottom"}
      align={props.align ?? "start"}
      className="w-80 max-w-[calc(100vw-16px)]"
    >
      <div className="flex h-bar shrink-0 items-center gap-2 border-b border-line px-3">
        <Glyph icon={Search} size={14} className="shrink-0 text-fg-3" />
        <input
          ref={search}
          data-autofocus
          role="combobox"
          aria-expanded="true"
          aria-controls={`${baseId}-list`}
          aria-activedescendant={current ? optionId(current.id) : undefined}
          aria-label={props.placeholder}
          placeholder={props.placeholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(null);
          }}
          onKeyDown={onKeyDown}
          className="h-full min-w-0 flex-1 bg-transparent text-sm text-fg placeholder:text-fg-3 focus:outline-none focus-visible:shadow-none max-sm:text-input-touch"
        />
      </div>
      <div
        ref={list}
        id={`${baseId}-list`}
        role="listbox"
        tabIndex={-1}
        // One handler for every row (the field keeps focus: rows are reached through aria-activedescendant).
        onMouseDown={(e) => e.preventDefault()}
        // Keys belong to the search field (it owns the active row).
        onKeyDown={() => search.current?.focus()}
        onClick={(e) => {
          const row = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-picker-row]") : null;
          if (row && !(e.target instanceof Element && e.target.closest("button"))) run(row.dataset.pickerRow);
        }}
        aria-label={props.label}
        className="min-h-0 overflow-y-auto overscroll-contain p-1"
        style={{ maxHeight: VISIBLE * ROW + 8 }}
      >
        {sections.map((s) =>
          s.rows.length === 0 ? null : (
            <div key={s.title} role="group" aria-labelledby={`${baseId}-g-${s.title.replace(/\W/g, "_")}`}>
              <div id={`${baseId}-g-${s.title.replace(/\W/g, "_")}`} className="flex h-row items-center px-2 text-xs text-fg-3">
                {s.title}
              </div>
              {s.rows.map((r) => {
                const digit = props.digits ? (digitOf.get(r.id) ?? null) : null;
                const on = current?.id === r.id;
                return (
                  <div
                    key={r.id}
                    id={optionId(r.id)}
                    role="option"
                    aria-selected={on}
                    aria-disabled={r.disabled || undefined}
                    aria-checked={r.checked}
                    title={r.title}
                    data-picker-row={r.id}
                    onPointerMove={() => !r.disabled && !on && setActive(r.id)}
                    className={cn(
                      "group flex h-row min-w-0 items-center gap-2 rounded-sm px-2 press-row max-md:h-bar",
                      r.disabled ? "text-fg-3" : on ? "bg-active text-fg" : "text-fg",
                    )}
                  >
                    <span aria-hidden className="grid size-4 shrink-0 place-items-center text-fg-3">
                      {r.lead}
                    </span>
                    <span className="min-w-0 shrink truncate">
                      <Highlight text={r.label} query={query} />
                    </span>
                    {r.checked && <span className="sr-only">(current)</span>}
                    {/* On the active row the muted detail steps up to fg-2 (fg-3 over the active fill measured 4.06:1). */}
                    {r.detail && <span className={cn("min-w-0 flex-1 truncate text-xs", on ? "text-fg-2" : "text-fg-3")}>{r.detail}</span>}
                    <span className="ml-auto flex shrink-0 items-center gap-1 pl-1">
                      {r.hint && <span className={cn("text-xs", on ? "text-fg-2" : "text-fg-3")}>{r.hint}</span>}
                      {digit !== null && (
                        <kbd aria-hidden className={cn("font-sans text-xs tabular-nums", on ? "text-fg-2" : "text-fg-3")}>
                          {MOD_LABEL}
                          {digit}
                        </kbd>
                      )}
                      {r.checked && <span aria-hidden className="size-1.5 rounded-full bg-fg-2" />}
                      {r.star && (
                        <button
                          type="button"
                          tabIndex={-1}
                          aria-label={r.star.on ? `Remove ${r.label} from favourites` : `Add ${r.label} to favourites`}
                          title={`${r.star.on ? "Remove from" : "Add to"} favourites (${MOD_LABEL}D)`}
                          aria-pressed={r.star.on}
                          onClick={(e) => {
                            e.stopPropagation();
                            r.star?.toggle();
                          }}
                          className={cn(
                            "-mr-1 grid size-6 place-items-center rounded-sm hover:bg-hover hover:text-fg",
                            r.star.on ? "text-fg-2" : "text-fg-3 opacity-0 group-hover:opacity-100",
                            (on || r.star.on) && "opacity-100",
                          )}
                        >
                          <Glyph icon={Star} size={14} fill={r.star.on ? "currentColor" : "none"} />
                        </button>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          ),
        )}
        {flat.length === 0 && <p className="flex h-row items-center px-2 text-xs text-fg-3">{props.empty ?? "Nothing matches"}</p>}
      </div>
      {props.footer && <div className="shrink-0 border-t border-line p-1">{props.footer}</div>}
    </Popover>
  );
}
