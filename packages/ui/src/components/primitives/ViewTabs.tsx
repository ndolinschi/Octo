import { ChevronDown } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { listKeyTarget } from "../../lib/focus";
import { Glyph } from "./Glyph";
import { Menu, type MenuItem } from "./Menu";
import { Presence } from "./Presence";

export type ViewTab<T extends string> = {
  id: T;
  label: string;
  title?: string;
  /** Makes the label a menu while the tab is the chosen one (a tab that stands for one of several things: "which project"). */
  menu?: MenuItem[];
};

/**
 * Decision 82 (a): the switcher between a panel's views (Sessions, Tasks, Files...). One full-width row at the top of the
 * content with a hairline under the whole row, the same separator token as between frame levels. The chosen view is
 * marked by text weight and a 2px underline that sits on the hairline, never by a filled pill. Views are separate
 * screens, so a panel holds one of these row; filters of a list use `FilterTabs`, which looks different on purpose.
 * One tab stop; ←/→ / Home / End move and choose (roving focus, automatic activation). Text never truncates: the row
 * scrolls sideways before it clips. A tab with `menu` opens it on a second press (a chevron after its label). `trailing` is an optional control at the right end (a count, a refresh).
 */
export function ViewTabs<T extends string>(props: {
  label: string;
  options: readonly ViewTab<T>[];
  value: T;
  onChange(value: T): void;
  trailing?: ReactNode;
  contentClassName?: string;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[]; label: string } | null>(null);
  const at = Math.max(
    0,
    props.options.findIndex((o) => o.id === props.value),
  );
  const onKeyDown = (e: KeyboardEvent) => {
    const key = e.key === "ArrowRight" ? "ArrowDown" : e.key === "ArrowLeft" ? "ArrowUp" : e.key;
    const to = listKeyTarget(key, at, props.options.length);
    const next = to === null ? undefined : props.options[to];
    if (!next) return;
    e.preventDefault();
    props.onChange(next.id);
    box.current?.querySelectorAll<HTMLElement>('[role="tab"]')[to ?? 0]?.focus();
  };
  return (
    <div className={cn("box-content h-row-nav shrink-0 border-b border-line touch:h-ctl-lg", props.className)}>
      <div className={cn("flex h-full min-w-0 items-stretch px-pane", props.contentClassName)}>
        <div ref={box} role="tablist" tabIndex={-1} aria-label={props.label} onKeyDown={onKeyDown} className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {props.options.map((o) => {
            const on = o.id === props.value;
            return (
              <button
                key={o.id}
                type="button"
                role="tab"
                aria-selected={on}
                tabIndex={on ? 0 : -1}
                title={o.title}
                {...(o.menu && on ? { "aria-haspopup": "menu" as const, "aria-expanded": menu !== null } : {})}
                onClick={(e) => {
                  if (o.menu && on) {
                    const r = e.currentTarget.getBoundingClientRect();
                    setMenu(menu ? null : { x: r.left, y: r.bottom + 4, items: o.menu, label: o.label });
                  } else props.onChange(o.id);
                }}
                className={cn(
                  "relative shrink-0 px-2 text-sm whitespace-nowrap press-row focus-inset",
                  on ? "font-medium text-fg" : "text-fg-3 hover:text-fg-2",
                  // The underline rests on the row's hairline.
                  on && "after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-fg",
                )}
              >
                {o.label}
                {o.menu && <Glyph icon={ChevronDown} size={14} className="ml-1 inline align-text-bottom text-fg-3" />}
              </button>
            );
          })}
        </div>
        {props.trailing && <div className="flex shrink-0 items-center pl-2">{props.trailing}</div>}
      </div>
      <Presence show={menu !== null}>{menu && <Menu label={menu.label} x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}</Presence>
    </div>
  );
}
