import { ChevronDown } from "lucide-react";
import { useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { Glyph } from "./Glyph";
import { Menu, type MenuItem } from "./Menu";
import { Presence } from "./Presence";

/**
 * A quiet text button with a 14px chevron that opens a menu (decision 33: options are a menu, not a button group).
 * 24px, `fg-2` text, no border; the `hover` fill while hovered and `active` while its menu is open. The label never
 * truncates — it is the control's whole meaning.
 */
export function MenuButton(props: { label: string; text: string; items: MenuItem[]; alignEnd?: boolean; className?: string }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const toggle = () => {
    const r = button.current?.getBoundingClientRect();
    if (r) setMenu(menu ? null : { x: props.alignEnd ? r.right : r.left, y: r.bottom + 4 });
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={`${props.label}: ${props.text}`}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={toggle}
        className={cn(
          "flex h-chip shrink-0 press items-center gap-1 rounded-sm px-2 text-sm whitespace-nowrap hover:bg-hover hover:text-fg",
          menu ? "bg-active text-fg" : "text-fg-2",
          props.className,
        )}
      >
        {props.text}
        <Glyph icon={ChevronDown} size={14} className="shrink-0 text-fg-3" />
      </button>
      <Presence show={menu !== null} exitMs={0}>
        {menu && <Menu label={props.label} x={menu.x} y={menu.y} alignEnd={props.alignEnd ?? false} items={props.items} onClose={() => setMenu(null)} />}
      </Presence>
    </>
  );
}
