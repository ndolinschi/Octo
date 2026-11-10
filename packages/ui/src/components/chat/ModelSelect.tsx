import { ChevronDown } from "lucide-react";
import { useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { Menu } from "../primitives/Menu";
import { Presence } from "../primitives/Presence";
import { modelLabel } from "../primitives/Status";

/**
 * The orchestrator's model, in the composer's control row: a quiet button that opens a menu of the
 * project's models and the bridge's defaults (current one checked). Choosing calls `onChoose`, which
 * the composer awaits to show an error and roll back.
 */
export function ModelSelect(props: { value: string; options: string[]; onChoose(model: string): void; disabled?: boolean }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const open = () => {
    const r = button.current?.getBoundingClientRect();
    if (r) setMenu({ x: r.left, y: r.top - 4 });
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={`Orchestrator model: ${props.value}`}
        title={`Orchestrator model: ${props.value}`}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        disabled={props.disabled}
        onClick={() => (menu ? setMenu(null) : open())}
        className={cn(
          "press flex h-row min-w-0 shrink items-center gap-1 rounded-sm px-2 text-xs hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:text-fg-3",
          menu ? "bg-active text-fg" : "text-fg-2",
        )}
      >
        <span className="truncate">{modelLabel(props.value)}</span>
        <ChevronDown size={12} strokeWidth={1.5} absoluteStrokeWidth aria-hidden className="shrink-0" />
      </button>
      <Presence show={menu !== null} exitMs={0}>
        {menu && (
          <Menu
            label="Orchestrator model"
            x={menu.x}
            y={menu.y}
            above
            onClose={() => setMenu(null)}
            items={props.options.map((m) => ({ id: m, label: modelLabel(m), title: m, checked: m === props.value, run: () => props.onChoose(m) }))}
          />
        )}
      </Presence>
    </>
  );
}
