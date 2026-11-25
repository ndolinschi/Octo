import { Check, ChevronDown, ChevronsUpDown } from "lucide-react";
import { forwardRef, Fragment, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "../../lib/cn";
import { CONTROL, FIELD, type ControlSize } from "../../lib/controls";
import { createPointerGate, popupTarget } from "./popupNav";
import { Glyph } from "./Glyph";
import { Popover } from "./Popover";
import { Presence } from "./Presence";

/** `group` is a heading shown above the first option that has it (options of one group sit together, like `optgroup`). */
export type SelectOption = { value: string; label: string; description?: string; disabled?: boolean; group?: string };

/** How long typed letters keep building one prefix (type-ahead), in ms. */
const TYPE_AHEAD_MS = 700;

/**
 * A choice from a short list, as a menu (decision 90; never the platform `<select>`). The trigger has the field look
 * (`FIELD`: 8px radius, `input-border`, the shared focus rule) with a chevron; the list is a `Popover` of 28px rows with the
 * current one checked. Keys: Enter, Space or an arrow opens; arrows, Home and End move the active row, typing letters jumps
 * to the next option that starts with them, Enter chooses, Esc or Tab closes; focus returns to the trigger after any close.
 * A long list scrolls and keeps the active row in view.
 *
 * - `size`: xs 24, sm 28, md 32 (default), lg 40 (40 on touch).
 * - `side="top"` for a control at the bottom of a window: it opens upward with the up-down chevron pair (decision 56).
 * - `placeholder` shows while `value` matches no option.
 *
 * Not for: more than about 12 options or anything searchable (`Picker`), actions rather than a value (`MenuButton`),
 * two or three exclusive choices that fit a row (`Segmented`).
 */
type SelectProps = {
  value: string;
  onChange(value: string): void;
  options: readonly SelectOption[];
  /** Accessible name of the control. */
  label: string;
  placeholder?: string;
  size?: ControlSize;
  side?: "top" | "bottom";
  disabled?: boolean;
  invalid?: boolean;
  /** `aria-describedby` of the trigger (a form field's description and error). */
  describedBy?: string;
  /** `aria-required` of the trigger. */
  required?: boolean;
  id?: string;
  className?: string;
};

export const Select = forwardRef<HTMLButtonElement, SelectProps>(function Select(props, outer) {
  const { options, value } = props;
  const size = props.size ?? "md";
  const side = props.side ?? "bottom";
  const trigger = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState(0);
  const listId = useId();
  const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
  const current = options.find((o) => o.value === value);
  const optionId = (i: number) => `${listId}-${i}`;
  const typed = useRef({ text: "", at: 0 });
  const gate = useRef(createPointerGate());

  // Keeps the active row visible while arrows walk a list taller than the popover without scrolling ancestor containers.
  useEffect(() => {
    if (!open) return;
    const box = listRef.current;
    const item = document.getElementById(`${listId}-${active}`);
    if (!box || !item) return;
    const br = box.getBoundingClientRect();
    const ir = item.getBoundingClientRect();
    if (ir.top < br.top) box.scrollTop -= br.top - ir.top;
    else if (ir.bottom > br.bottom) box.scrollTop += ir.bottom - br.bottom;
  }, [open, active, listId]);

  const show = () => {
    if (props.disabled) return;
    setWidth(trigger.current?.offsetWidth ?? 0);
    const match = options.findIndex((o) => o.value === value && !o.disabled);
    const first = options.findIndex((o) => !o.disabled);
    setActive(match >= 0 ? match : first >= 0 ? first : 0);
    setOpen(true);
  };
  const choose = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    setOpen(false);
    // The popover goes inert as it closes; without this focus would fall to the page.
    trigger.current?.focus({ preventScroll: true });
    props.onChange(o.value);
  };
  const onTriggerKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      show();
    }
  };
  const onListKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      choose(active);
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      setOpen(false);
      trigger.current?.focus({ preventScroll: true });
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const t = typed.current;
      const now = performance.now();
      t.text = (now - t.at > TYPE_AHEAD_MS ? "" : t.text) + e.key.toLowerCase();
      t.at = now;
      // A repeated single letter cycles through the options that start with it.
      const cycle = /^(.)\1*$/u.test(t.text);
      const prefix = cycle ? t.text.slice(0, 1) : t.text;
      const from = enabled.indexOf(active);
      const order = [...enabled.slice(from + (cycle ? 1 : 0)), ...enabled.slice(0, from + (cycle ? 1 : 0))];
      const hit = order.find((i) => options[i]?.label.toLowerCase().startsWith(prefix));
      if (hit !== undefined) {
        e.preventDefault();
        setActive(hit);
      }
      return;
    }
    const to = popupTarget(e.key, enabled.map(String), String(active));
    if (to === null) return;
    e.preventDefault();
    setActive(Number(to));
  };

  return (
    <>
      <button
        ref={(el) => {
          trigger.current = el;
          if (typeof outer === "function") outer(el);
          else if (outer) outer.current = el;
        }}
        type="button"
        id={props.id}
        role="combobox"
        aria-label={props.label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-invalid={props.invalid || undefined}
        aria-describedby={props.describedBy}
        aria-required={props.required || undefined}
        disabled={props.disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onTriggerKey}
        className={cn(
          FIELD,
          "touch-hit flex w-full min-w-0 items-center justify-between gap-2 px-3 text-left disabled:opacity-50 touch:h-ctl-lg",
          open && "border-fg",
          CONTROL[size].h,
          props.className,
        )}
      >
        <span className={cn("min-w-0 truncate", !current && "text-fg-3")}>{current?.label ?? props.placeholder ?? ""}</span>
        <Glyph icon={side === "top" ? ChevronsUpDown : ChevronDown} size={14} className="shrink-0 text-fg-3" />
      </button>
      <Presence show={open}>
        <Popover anchor={trigger} label={props.label} side={side} gap={4} onClose={() => setOpen(false)}>
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            tabIndex={0}
            data-autofocus
            aria-label={props.label}
            aria-activedescendant={optionId(active)}
            onKeyDown={onListKey}
            onClick={(e) => {
              const row = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-option]") : null;
              if (row) choose(Number(row.dataset.option));
            }}
            style={{ minWidth: width }}
            className="flex flex-col overflow-y-auto overscroll-contain p-1 focus:outline-none focus-visible:shadow-none"
          >
            {options.map((o, i) => (
              <Fragment key={o.value}>
                {o.group !== undefined && o.group !== options[i - 1]?.group && (
                  <div role="presentation" className="flex h-ctl-sm items-center px-2 text-xs text-fg-3">
                    {o.group}
                  </div>
                )}
                <div
                  id={optionId(i)}
                  role="option"
                  aria-selected={o.value === value}
                  aria-disabled={o.disabled || undefined}
                  onPointerMove={(e) => gate.current(e) && !o.disabled && setActive(i)}
                  data-option={i}
                  className={cn(
                    "flex min-w-0 items-center gap-2 rounded-md px-2 press-row touch:min-h-ctl-lg",
                    o.description ? "min-h-ctl-lg py-1" : "h-ctl-sm",
                    o.disabled ? "text-fg-3" : i === active ? "bg-active text-fg" : "text-fg",
                  )}
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="min-w-0 truncate">{o.label}</span>
                    {o.description && <span className={cn("min-w-0 truncate text-xs", i === active ? "text-fg-2" : "text-fg-3")}>{o.description}</span>}
                  </span>
                  <span aria-hidden className="grid size-4 shrink-0 place-items-center">
                    {o.value === value && <Glyph icon={Check} size={14} className="text-fg-2" />}
                  </span>
                </div>
              </Fragment>
            ))}
          </div>
        </Popover>
      </Presence>
    </>
  );
});
