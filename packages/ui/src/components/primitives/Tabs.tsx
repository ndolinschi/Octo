import { useRef, type KeyboardEvent } from "react";
import { cn } from "../../lib/cn";

export function Tabs<T extends string>(props: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange(value: T): void;
  idPrefix: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = props.options.findIndex((o) => o.value === props.value);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const delta = e.key === "ArrowRight" ? 1 : -1;
    const next = (index + delta + props.options.length) % props.options.length;
    props.onChange(props.options[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div role="tablist" aria-label={props.label} className="flex items-center gap-0.5" onKeyDown={onKeyDown}>
      {props.options.map((o, i) => {
        const selected = o.value === props.value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${props.idPrefix}-tab-${o.value}`}
            aria-selected={selected}
            aria-controls={`${props.idPrefix}-panel-${o.value}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => props.onChange(o.value)}
            className={cn(
              "inline-flex h-7 items-center rounded-sm px-2.5 text-sm transition-[background-color,color] duration-100",
              selected ? "bg-active text-fg" : "text-fg-3 hover:bg-hover hover:text-fg-2",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
