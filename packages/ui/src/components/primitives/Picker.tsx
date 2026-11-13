import { Search } from "lucide-react";
import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import type { PickerRow, PickerSection } from "../../lib/picker";
import { popupMove } from "./popupNav";
import { Glyph } from "./Glyph";
import { PopupList, popupOptionId } from "./PopupList";
import { Popover } from "./Popover";

export type { PickerRow, PickerSection } from "../../lib/picker";

/**
 * A searchable quick picker anchored to a control (decisions 25 and 27): a search field on top, then sections of
 * 28px rows (leading glyph, name with the match highlighted, muted detail and a right-aligned hint).
 * The field keeps focus: ↑/↓ (and Ctrl+Home/End) move the active row (disabled rows are skipped), Enter runs it, Tab moves focus
 * inside the popover (or completes, with `complete`); Esc or a click outside closes and focus returns to the opener (the `Popover`). `sections` is computed by the caller from the query.
 */
export function Picker(props: {
  anchor: RefObject<HTMLElement | null>;
  label: string;
  placeholder: string;
  sections(query: string): PickerSection[];
  onClose(): void;
  side?: "top" | "bottom";
  align?: "start" | "end";
  /** Under the list, after a hairline (the model picker's Routing row). */
  footer?: ReactNode;
  empty?: string;
  /** Open above / below this element instead of the anchor (the whole composer, not its context bar). */
  edge?: () => HTMLElement | null;
  /** Hears the query (a caller that loads rows for it: the folder picker's path completion). */
  onQuery?(query: string): void;
  /** `Tab` on the active row: the text that replaces the query (path completion), or null to do nothing. */
  complete?(row: PickerRow): string | null;
  /** Gap to the anchor (Popover's default 6). */
  gap?: number;
  /** Width class of the popover (default 320px). */
  widthClass?: string;
  /** The search field, for a caller that returns focus to it (after a system dialog was cancelled). */
  searchRef?: RefObject<HTMLInputElement | null>;
  /** A key the picker does not know: return true when it was the caller's (a row's shortcut). */
  onShortcut?(e: KeyboardEvent<HTMLInputElement>): boolean;
}) {
  const { onClose } = props;
  const [query, setQuery] = useState("");
  const sections = props.sections(query);
  const flat = useMemo(() => sections.flatMap((s) => s.rows), [sections]);
  const enabled = flat.filter((r) => !r.disabled);
  const enabledIds = enabled.map((r) => r.id);
  const [active, setActive] = useState<string | null>(null);
  const current = enabled.find((r) => r.id === active) ?? enabled[0] ?? null;
  const ownSearch = useRef<HTMLInputElement>(null);
  const search = props.searchRef ?? ownSearch;
  const baseId = useId();
  const optionId = (id: string) => popupOptionId(`${baseId}-list`, id);

  const run = (id: string | undefined) => {
    const row = flat.find((r) => r.id === id);
    if (!row || row.disabled) return;
    if (!row.keepOpen) onClose();
    row.run();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (props.onShortcut?.(e)) {
      e.preventDefault();
      return;
    }
    // Decision 95: the search field is a text field, so plain Home / End move its caret (`popupNav`).
    const to = popupMove(e, true, enabledIds, current?.id ?? null);
    if (to !== null) {
      e.preventDefault();
      setActive(to);
      return;
    }
    if (e.key === "Tab" && !e.shiftKey && props.complete && current) {
      const next = props.complete(current);
      if (next !== null) {
        e.preventDefault();
        setQuery(next);
        setActive(null);
        props.onQuery?.(next);
        return;
      }
    }
    if (e.key === "Enter") {
      e.preventDefault();
      run(current?.id);
      return;
    }
  };

  return (
    <Popover
      anchor={props.anchor}
      label={props.label}
      onClose={onClose}
      {...(props.edge ? { edge: props.edge } : {})}
      {...(props.gap !== undefined ? { gap: props.gap } : {})}
      side={props.side ?? "bottom"}
      align={props.align ?? "start"}
      className={props.widthClass ?? "w-80 max-w-[calc(100vw-16px)]"}
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
            props.onQuery?.(e.target.value);
          }}
          onKeyDown={onKeyDown}
          className="h-full min-w-0 flex-1 bg-transparent text-sm text-fg placeholder:text-fg-3 focus:outline-none focus-visible:shadow-none max-sm:text-input-touch"
        />
      </div>
      <PopupList
        id={`${baseId}-list`}
        label={props.label}
        sections={sections}
        activeId={current?.id ?? null}
        onActive={setActive}
        onChoose={(row) => run(row.id)}
        onKeyDown={() => search.current?.focus()}
        query={query}
        {...(props.empty !== undefined ? { empty: props.empty } : {})}
      />
      {props.footer && <div className="shrink-0 border-t border-line p-1">{props.footer}</div>}
    </Popover>
  );
}
