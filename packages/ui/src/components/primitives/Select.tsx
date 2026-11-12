import { Check, ChevronDown, ChevronsUpDown } from "lucide-react";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "../../lib/cn";
import { CONTROL, FIELD, type ControlSize } from "../../lib/controls";
import { listKeyTarget } from "../../lib/focus";
import { Glyph } from "./Glyph";
import { Popover } from "./Popover";
import { Presence } from "./Presence";

export type SelectOption = { value: string; label: string; description?: string; disabled?: boolean };

/**
 * A choice from a short list, as a menu (decision 90; never the platform `<select>`). The trigger has the field look
 * (`FIELD`: 8px radius, `input-border`, the shared focus rule) with a chevron; the list is a `Popover` of 28px rows with the
 * current one checked. Keys: Enter, Space or an arrow opens; arrows, Home and End move the active row, Enter chooses, Esc
 * closes and returns focus to the trigger.
 *
 * - `size`: xs 24, sm 28, md 32 (default), lg 40 (40 on touch).
 * - `side="top"` for a control at the bottom of a window: it opens upward with the up-down chevron pair (decision 56).
 * - `placeholder` shows while `value` matches no option.
 *
 * Not for: more than about 12 options or anything searchable (`Picker`), actions rather than a value (`MenuButton`),
 * two or three exclusive choices that fit a row (`Segmented`).
 */
export function Select(props: {
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
  id?: string;
  className?: string;
}) {
  const { options, value } = props;
  const size = props.size ?? "md";
  const side = props.side ?? "bottom";
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState(0);
  const listId = useId();
  const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
  const current = options.find((o) => o.value === value);
  const optionId = (i: number) => `${listId}-${i}`;

  const show = () => {
    if (props.disabled) return;
    setWidth(trigger.current?.offsetWidth ?? 0);
    setActive(
      Math.max(
        0,
        options.findIndex((o) => o.value === value),
      ),
    );
    setOpen(true);
  };
  const choose = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    setOpen(false);
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
    const at = Math.max(0, enabled.indexOf(active));
    const to = listKeyTarget(e.key, at, enabled.length);
    const next = to === null ? undefined : enabled[to];
    if (next === undefined) return;
    e.preventDefault();
    setActive(next);
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        id={props.id}
        role="combobox"
        aria-label={props.label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-invalid={props.invalid || undefined}
        disabled={props.disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onTriggerKey}
        className={cn(
          FIELD,
          "touch-hit flex w-full min-w-0 items-center justify-between gap-2 px-3 text-left disabled:opacity-50 touch:h-ctl-lg",
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
              <div
                key={o.value}
                id={optionId(i)}
                role="option"
                aria-selected={o.value === value}
                aria-disabled={o.disabled || undefined}
                onPointerMove={() => !o.disabled && setActive(i)}
                data-option={i}
                className={cn(
                  "flex min-w-0 items-center gap-2 rounded-sm px-2 press-row touch:min-h-ctl-lg",
                  o.description ? "min-h-ctl-lg py-1" : "h-ctl-sm",
                  o.disabled ? "text-fg-3" : i === active ? "bg-active text-fg" : "text-fg",
                )}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="min-w-0 truncate">{o.label}</span>
                  {o.description && <span className="min-w-0 truncate text-xs text-fg-3">{o.description}</span>}
                </span>
                <span aria-hidden className="size-4 shrink-0">
                  {o.value === value && <Glyph icon={Check} size={14} className="text-fg-2" />}
                </span>
              </div>
            ))}
          </div>
        </Popover>
      </Presence>
    </>
  );
}
