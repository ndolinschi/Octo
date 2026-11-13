import { Check } from "lucide-react";
import { Glyph } from "./Glyph";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { usePresence } from "./Presence";
import { createPointerGate, popupListKey, popupTarget } from "./popupNav";

export type MenuItem =
  | {
      id: string;
      label: string;
      shortcut?: string;
      /** Dim text after the label (a role, a remote). */ detail?: string;
      disabled?: boolean;
      /** A choice in a set (menuitemradio). */ checked?: boolean;
      title?: string;
      run(): void;
    }
  | { id: string; separator: true };

const isAction = (item: MenuItem): item is Extract<MenuItem, { run(): void }> => !("separator" in item);

/** Gap kept between the menu and the viewport edges. */
const EDGE = 8;

const ITEM = '[data-menu-item]:not([aria-disabled="true"])';

/**
 * A small context menu at a point (pointer position or a control's corner), or opening upwards from it with `above`. It appears
 * and leaves instantly (no animation). Keys follow decision 95's one contract (`popupNav`; a menu has no text field): ↑/↓ wrap,
 * Home/End jump, Tab / Shift+Tab move to the next / previous item (focus stays in the menu), type-ahead moves; Enter/Space runs;
 * Esc, a click outside, resizing the window or scrolling closes. Rows look like `PopupList`'s: a 16px leading slot (the check of a
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
}) {
  const { onClose } = props;
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
    const flipY = props.above || props.y + height + EDGE > window.innerHeight;
    setPos({
      left: Math.max(EDGE, flipX ? props.x - width : props.x),
      top: Math.max(EDGE, flipY ? props.y - height : props.y),
    });
  }, [props.x, props.y, props.above, props.alignEnd]);

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
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const close = () => onClose();
    // A scroll that moves the opener closes the menu; a live transcript scrolling elsewhere does not.
    const scrolled = (e: Event) => {
      const t = e.target;
      const o = opener.current;
      if (t === document || (t instanceof Node && !ref.current?.contains(t) && (!o || t.contains(o)))) onClose();
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    document.addEventListener("scroll", scrolled, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      document.removeEventListener("scroll", scrolled, true);
    };
  }, [open, onClose]);

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
    if (e.key.length === 1 && /\S/.test(e.key)) {
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

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={props.label}
      data-state={state}
      inert={!open}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      style={{ left: pos.left, top: pos.top }}
      className="fixed z-[60] max-h-[calc(100dvh-24px)] max-w-[calc(100vw-24px)] min-w-[200px] overflow-y-auto overscroll-contain rounded-lg border border-transparent bg-overlay p-1 text-sm shadow-pop"
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
              "flex h-row items-center gap-2 rounded-sm px-2 outline-none focus-visible:shadow-none touch:h-ctl-lg",
              item.disabled ? "text-fg-3" : "text-fg focus:bg-active",
            )}
          >
            {/* The same 16px leading slot as `PopupList`'s rows, so every popup's text starts on one line. */}
            <span aria-hidden className="grid size-4 shrink-0 place-items-center">
              {item.checked && <Glyph icon={Check} size={14} />}
            </span>
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.detail && <span className="shrink-0 pl-4 text-xs text-fg-3">{item.detail}</span>}
            {item.shortcut && <kbd className="shrink-0 pl-4 font-sans text-xs text-fg-2">{item.shortcut}</kbd>}
          </div>
        ) : (
          <div key={item.id} role="separator" className="mx-2 my-1 h-px bg-line" />
        ),
      )}
    </div>,
    document.body,
  );
}
