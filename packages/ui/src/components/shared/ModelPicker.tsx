import { ChevronDown, ChevronsUpDown, Cpu } from "lucide-react";
import { lazy, Suspense, useRef, useState } from "react";
import type { ModelPickerProps } from "./modelPickerProps";

import { cn } from "../../lib/cn";
import { modelName } from "../../lib/models";
import { useApp } from "../../state/app";
import { Glyph } from "../primitives/Glyph";
import { Presence } from "../primitives/Presence";

/** The list loads on first open (its own chunk): the button is all the composer and the header need up front. */
const ModelPickerPanel = lazy(() => import("./ModelPickerPanel").then((m) => ({ default: m.ModelPickerPanel })));

/**
 * The model picker (decision 27): a quiet button naming the current choice — an `acp:` value reads as the agent's label
 * and model — that opens a 320px searchable list: Favourites (once something is starred, `Ctrl/Cmd+D` or the star),
 * Tiers, Models, Agents (logged-out agents disabled with their login hint), `Ctrl/Cmd+1…9` on the first nine rows, and
 * the routing policy when a router is detected. Effort and compaction are not offered: the harness takes neither yet.
 */
export function ModelPicker(props: ModelPickerProps) {
  const { config } = useApp();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const acp = config?.acp_orchestrators ?? [];
  const name = modelName(props.value, acp);
  const variant = props.variant ?? "bar";

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={`${props.label}: ${name}`}
        title={props.title ?? `${props.label}: ${props.value}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={props.disabled}
        data-model-picker
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex min-w-0 shrink-0 press items-center gap-1.5 rounded-sm text-left whitespace-nowrap disabled:pointer-events-none disabled:text-fg-3",
          variant === "field"
            ? "h-row-nav w-full border border-line-strong bg-raised px-3 text-sm text-fg hover:bg-hover"
            : variant === "text"
              ? "h-chip px-1.5 text-xs text-fg-3 hover:bg-hover hover:text-fg"
              : "h-chip px-1.5 text-xs text-fg-2 hover:bg-hover hover:text-fg",
          open && "bg-active text-fg",
          props.className,
        )}
      >
        {variant === "bar" && <Glyph icon={Cpu} size={14} className="shrink-0 text-fg-3" />}
        <span className="min-w-0 truncate">{props.children ?? name}</span>
        {/* Decision 56: a control that opens upward (the composer's chips) shows the up-down pair. */}
        <Glyph icon={variant === "bar" ? ChevronsUpDown : ChevronDown} size={14} className={cn("shrink-0 text-fg-3", variant === "field" && "ml-auto")} />
      </button>
      <Presence show={open} exitMs={0}>
        {open && (
          <Suspense fallback={null}>
            <ModelPickerPanel {...props} anchor={button} onClose={() => setOpen(false)} />
          </Suspense>
        )}
      </Presence>
    </>
  );
}
