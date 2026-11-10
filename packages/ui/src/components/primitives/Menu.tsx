import { Check } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { usePresence } from "./Presence";

export type MenuItem =
  | { id: string; label: string; shortcut?: string; disabled?: boolean; /** A choice in a set (menuitemradio). */ checked?: boolean; title?: string; run(): void }
  | { id: string; separator: true };

const isAction = (item: MenuItem): item is Extract<MenuItem, { run(): void }> => !("separator" in item);

/** Gap kept between the menu and the viewport edges. */
const EDGE = 8;

const ITEM = '[data-menu-item]:not([aria-disabled="true"])';

/**
 * A small context menu at a point (or opening upwards from it with `above`). It appears and leaves instantly (no animation): (pointer position or a control's corner). Arrow keys, Home/End and
 * type-ahead move; Enter/Space runs; Esc, Tab, a click outside or scrolling closes. Focus moves into the
 * menu on open and back to the opener when it starts closing.
 */
export function Menu(props: { label: string; x: number; y: number; items: MenuItem[]; onClose(): void; above?: boolean }) {
  const { onClose } = props;
  const ref = useRef<HTMLDivElement>(null);
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
    const flipX = props.x + width + EDGE > window.innerWidth;
    const flipY = props.above || props.y + height + EDGE > window.innerHeight;
    setPos({
      left: Math.max(EDGE, flipX ? props.x - width : props.x),
      top: Math.max(EDGE, flipY ? props.y - height : props.y),
    });
  }, [props.x, props.y, props.above]);

  useEffect(() => {
    opener.current = document.activeElement as HTMLElement | null;
    (ref.current?.querySelector<HTMLElement>(`${ITEM}[aria-checked="true"]`) ?? ref.current?.querySelector<HTMLElement>(ITEM))?.focus();
    return () => {
      if (opener.current?.isConnected) opener.current.focus();
    };
  }, []);

  useEffect(() => {
    if (open) return;
    if (opener.current?.isConnected) opener.current.focus();
    opener.current = null;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const close = () => onClose();
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    document.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      document.removeEventListener("scroll", close, true);
    };
  }, [open, onClose]);

  const items = () => [...(ref.current?.querySelectorAll<HTMLElement>(ITEM) ?? [])];
  const move = (delta: number | "first" | "last") => {
    const list = items();
    if (!list.length) return;
    const i = list.indexOf(document.activeElement as HTMLElement);
    const next = delta === "first" ? 0 : delta === "last" ? list.length - 1 : (i + delta + list.length) % list.length;
    list[next].focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const keys: Record<string, () => void> = {
      ArrowDown: () => move(1),
      ArrowUp: () => move(-1),
      Home: () => move("first"),
      End: () => move("last"),
      Escape: onClose,
      Tab: onClose,
    };
    const fn = keys[e.key];
    if (fn) {
      e.preventDefault();
      e.stopPropagation();
      fn();
      return;
    }
    if (e.key.length === 1 && /\S/.test(e.key)) {
      const hit = enabled.find((a) => a.label.toLowerCase().startsWith(e.key.toLowerCase()));
      if (hit) items().find((el) => el.dataset.id === hit.id)?.focus();
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
      className="fixed z-[60] min-w-[200px] overscroll-contain rounded-md border border-transparent bg-overlay p-1 text-sm shadow-pop"
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
              if (!item.disabled) e.currentTarget.focus();
            }}
            className={cn(
              // Radius = menu radius (8) − its padding (4).
              "flex h-row items-center gap-6 rounded-xs px-2 outline-none focus-visible:shadow-none",
              item.disabled ? "text-fg-3" : "text-fg focus:bg-active",
            )}
          >
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.shortcut && <kbd className="shrink-0 font-sans text-xs text-fg-2">{item.shortcut}</kbd>}
            {item.checked !== undefined && (
              <span aria-hidden className="grid size-4 shrink-0 place-items-center">
                {item.checked && <Check size={14} strokeWidth={1.5} absoluteStrokeWidth />}
              </span>
            )}
          </div>
        ) : (
          <div key={item.id} role="separator" className="mx-2 my-1 h-px bg-line" />
        ),
      )}
    </div>,
    document.body,
  );
}
