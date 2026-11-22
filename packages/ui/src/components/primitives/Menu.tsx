import { Check, type LucideIcon } from "lucide-react";
import { Glyph } from "./Glyph";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { usePresence } from "./Presence";
import { createPointerGate, popupListKey, popupTarget } from "./popupNav";
import { useCloseOnScroll } from "./popupScroll";

export type MenuItem =
  | {
      id: string;
      label: string;
      icon?: LucideIcon;
      shortcut?: string;
      /** Dim text after the label (a role, a remote). */ detail?: string;
      /** A second, dim line under the label: what the row does (the row grows to 40px). */ sub?: string;
      disabled?: boolean;
      /** A choice in a set (menuitemradio). */ checked?: boolean;
      title?: string;
      run(): void;
    }
  | { id: string; separator: true }
  /** A line of plain dim text on the label's left edge: not a row, not focusable (a count, a total). */
  | { id: string; caption: string; title?: string };

const isAction = (item: MenuItem): item is Extract<MenuItem, { run(): void }> => !("separator" in item) && !("caption" in item);

/** Gap kept between the menu and the viewport edges. */
const EDGE = 8;

const ITEM = '[data-menu-item]:not([aria-disabled="true"])';

/**
 * A small context menu at a point (pointer position or a control's corner), or opening upwards from it with `above`. It enters and
 * leaves like every overlay (`octo-overlay`, growing from the point it opened at; inside a `<Presence>` for the exit), and
 * instantly when opened from the keyboard. Keys follow decision 95's one contract (`popupNav`; a menu has no text field): ↑/↓ wrap,
 * Home/End jump, Tab / Shift+Tab move to the next / previous item (focus stays in the menu), type-ahead moves; Enter/Space runs;
 * Esc, a click outside, resizing the window or a scroll that moves the opener (`popupScroll`) closes. Rows look like `PopupList`'s: a 16px leading slot (the check of a
 * choice), 28px, 40px under `touch:`. Focus moves into the menu on open and back to the opener when it starts closing (unless the
 * chosen item moved it elsewhere).
 */
export function Menu(props: {
  label: string;
  x: number;
  y: number;
  items: MenuItem[];
  onClose(): void;
  above?: boolean;
  /** Opens leftwards from x (its right edge on x). */ alignEnd?: boolean;
  /** Trigger element excluded from click-outside closing so clicking it toggles cleanly. */
  ignoreRef?: RefObject<HTMLElement | null>;
}) {
  const { onClose, ignoreRef } = props;
  const ref = useRef<HTMLDivElement>(null);
  const gate = useRef(createPointerGate());
  const opener = useRef<HTMLElement | null>(null);
  const state = usePresence();
  const open = state === "open";
  const [pos, setPos] = useState({ left: props.x, top: props.y });
  const actions = props.items.filter(isAction);
  const enabled = actions.filter((a) => !a.disabled);

  // Keep the menu inside the viewport; flip towards the pointer where it would overflow.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const flipX = props.alignEnd || props.x + width + EDGE > window.innerWidth;
    const canFlipY = props.y - height >= EDGE;
    const flipY = props.above ? canFlipY : props.y + height + EDGE > window.innerHeight && canFlipY;
    const rawLeft = flipX ? props.x - width : props.x;
    const rawTop = flipY ? props.y - height : props.y;
    setPos({
      left: Math.min(Math.max(EDGE, rawLeft), Math.max(EDGE, window.innerWidth - width - EDGE)),
      top: Math.min(Math.max(EDGE, rawTop), Math.max(EDGE, window.innerHeight - height - EDGE)),
    });
  }, [props.x, props.y, props.above, props.alignEnd, props.items]);

  // Focus goes back to the opener unless the chosen item already moved it somewhere else (a rename field, a dialog):
  // only while it is still in a menu (this one, also when React has already let go of its ref) or on nothing.
  const restore = () => {
    const o = opener.current;
    opener.current = null;
    const at = document.activeElement;
    const kept = at !== null && at !== document.body && at.closest('[role="menu"]') === null;
    if (o?.isConnected && !kept) o.focus();
  };

  useEffect(() => {
    opener.current = document.activeElement as HTMLElement | null;
    (ref.current?.querySelector<HTMLElement>(`${ITEM}[aria-checked="true"]`) ?? ref.current?.querySelector<HTMLElement>(ITEM))?.focus();
    return restore;
  }, []);

  useEffect(() => {
    if (!open) restore();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !ignoreRef?.current?.contains(t)) onClose();
    };
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    const close = () => onClose();
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", esc, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", esc, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [open, onClose, ignoreRef]);

  // Decision: one scroll rule for every popup (`popupScroll`): closes only when the opener was left behind.
  useCloseOnScroll(open, ref, () => opener.current, onClose);

  const items = () => [...(ref.current?.querySelectorAll<HTMLElement>(ITEM) ?? [])];
  const move = (key: string) => {
    const list = items();
    const ids = list.map((el) => el.dataset.id ?? "");
    const at = list.find((el) => el === document.activeElement)?.dataset.id ?? null;
    const to = popupTarget(key, ids, at);
    list.find((el) => el.dataset.id === to)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // Tab moves focus as in every list that is not a typing menu; the menu's items are its only focusable elements.
    const key = e.key === "Tab" ? (e.shiftKey ? "ArrowUp" : "ArrowDown") : popupListKey(e, false);
    if (key !== null || e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (key === null) onClose();
      else move(key);
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && /\S/.test(e.key)) {
      const hit = enabled.find((a) => a.label.toLowerCase().startsWith(e.key.toLowerCase()));
      if (hit)
        items()
          .find((el) => el.dataset.id === hit.id)
          ?.focus();
    }
  };

  const run = (item: Extract<MenuItem, { run(): void }>) => {
    if (item.disabled) return;
    onClose();
    item.run();
  };

  const hasLeading = props.items.some((item) => isAction(item) && (item.checked !== undefined || item.icon !== undefined));

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={props.label}
      data-state={state}
      inert={!open}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      style={{ left: pos.left, top: pos.top, "--octo-origin": `${props.x - pos.left}px ${props.y - pos.top}px` } as CSSProperties}
      className="octo-overlay fixed z-[60] max-h-[calc(100dvh-24px)] max-w-[calc(100vw-24px)] min-w-[200px] overflow-y-auto overscroll-contain rounded-xl bg-overlay p-1 text-sm shadow-pop forced-colors:border forced-colors:border-[CanvasText]"
    >
      {props.items.map((item) =>
        isAction(item) ? (
          <div
            key={item.id}
            role={item.checked === undefined ? "menuitem" : "menuitemradio"}
            aria-checked={item.checked}
            tabIndex={-1}
            data-menu-item
            data-id={item.id}
            title={item.title}
            aria-disabled={item.disabled || undefined}
            onClick={() => run(item)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                run(item);
              }
            }}
            onPointerMove={(e) => {
              if (gate.current(e) && !item.disabled) e.currentTarget.focus();
            }}
            className={cn(
              // Radius 6 = menu radius (10) − its padding (4).
              "group/item flex items-center gap-2 rounded-md px-2 outline-none focus-visible:shadow-none touch:h-ctl-lg",
              item.sub ? "h-10" : "h-row",
              item.disabled ? "text-fg-3" : "text-fg focus:bg-active",
            )}
          >
            {hasLeading && (
              <span aria-hidden className="grid size-4 shrink-0 place-items-center">
                {item.checked ? <Glyph icon={Check} size={14} /> : item.icon ? <Glyph icon={item.icon} size={14} className="text-fg-3" /> : null}
              </span>
            )}
            {item.sub ? (
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{item.label}</span>
                <span className="truncate text-xs text-fg-3 group-focus/item:text-fg-2">{item.sub}</span>
              </span>
            ) : (
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
            )}
            {/* 5f: on the highlighted item the meta steps up to fg-2 (fg-3 on `active` was 4.06:1), as a selected ListRow's does. */}
            {item.detail && <span className="shrink-0 pl-4 text-xs text-fg-3 group-focus/item:text-fg-2">{item.detail}</span>}
            {item.shortcut && <kbd className="shrink-0 pl-4 font-sans text-xs text-fg-2">{item.shortcut}</kbd>}
          </div>
        ) : "caption" in item ? (
          <p key={item.id} title={item.title} className={cn("px-2 py-1 text-xs text-fg-3", hasLeading && "pl-8")}>
            {item.caption}
          </p>
        ) : (
          <div key={item.id} role="separator" className="mx-2 my-1 h-px bg-line" />
        ),
      )}
    </div>,
    document.body,
  );
}
