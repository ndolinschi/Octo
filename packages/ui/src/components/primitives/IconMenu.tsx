import { Ellipsis, type LucideIcon } from "lucide-react";
import { useRef, useState } from "react";
import { cn } from "../../lib/cn";
import type { ControlSize } from "../../lib/controls";
import { IconButton } from "./IconButton";
import { Menu, type MenuItem } from "./Menu";
import { Presence } from "./Presence";

/**
 * An icon button that opens a `Menu` under its right edge: the "⋯" of a detail or a card (Copy id, Forget, Export).
 * `label` is the accessible name and the tooltip; the button keeps the `active` fill while its menu is open.
 *
 * Not for: a menu whose trigger has a word (`MenuButton`), a value choice (`Select`), a context menu at the pointer (`Menu`).
 */
export function IconMenu(props: { label: string; items: MenuItem[]; icon?: LucideIcon; size?: ControlSize; className?: string }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton
        ref={button}
        icon={props.icon ?? Ellipsis}
        label={props.label}
        size={props.size ?? "sm"}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        className={cn(menu && "bg-active text-fg", props.className)}
        onClick={() => {
          const r = button.current?.getBoundingClientRect();
          if (r) setMenu(menu ? null : { x: r.right, y: r.bottom + 4 });
        }}
      />
      <Presence show={menu !== null} exitMs={0}>
        {menu && <Menu label={props.label} x={menu.x} y={menu.y} alignEnd ignoreRef={button} items={props.items} onClose={() => setMenu(null)} />}
      </Presence>
    </>
  );
}
