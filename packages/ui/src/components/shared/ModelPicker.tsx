import { ChevronDown } from "lucide-react";
import { lazy, Suspense, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { middleTruncate } from "../../lib/format";
import { canRun, chipLabel, chipParts } from "../../lib/providers/providers";
import { useProviders } from "../../lib/providers/useProviders";
import { parseAcp } from "../../lib/models";
import { useApp } from "../../state/app";
import { Chip } from "../primitives/Chip";
import { Glyph } from "../primitives/Glyph";
import { Presence } from "../primitives/Presence";
import type { ModelPickerProps } from "./modelPickerProps";

/** The chip's mark loads the same way (its SVG chunk after it): the box in the Suspense fallback holds its place, 14px, so nothing shifts when it arrives. */
const ProviderMark = lazy(() => import("../primitives/ProviderMark").then((m) => ({ default: m.ProviderMark })));

/** The list loads on first open (its own chunk): the chip is all the composer and the title bar need up front. */
const ModelPickerPanel = lazy(() => import("./ModelPickerPanel").then((m) => ({ default: m.ModelPickerPanel })));

/**
 * The one model control (decisions 53, 56, 58, 62): the composer's chip and the title bar's are this same component, reading
 * the same shared providers data, so they show the same words ("Claude Code · Opus", "Sonnet 5.5") and open the same list.
 * The list holds only what can run; providers that are not connected are one "Connect" row each.
 */
export function ModelPicker(props: ModelPickerProps) {
  const { bridge } = useApp();
  const providers = useProviders(bridge);
  const [open, setOpenState] = useState(false);
  const [served, setServed] = useState(props.openRequest?.n ?? 0);
  if (props.openRequest && props.openRequest.n !== served) {
    setServed(props.openRequest.n);
    setOpenState(true);
  }
  const button = useRef<HTMLButtonElement>(null);
  const setOpen = (next: boolean) => {
    setOpenState(next);
    props.onOpenChange?.(next);
  };
  const list = providers.status === "ready" || providers.status === "error" ? providers.list : null;
  const label = props.children ?? chipLabel(props.value, list);
  const text = typeof label === "string" ? label : chipLabel(props.value, list);
  // Decision 53 d: a setting whose provider cannot run it now is said where it is used.
  const broken = props.warn === true || (list !== null && props.value !== "" && !canRun(list, props.value));
  const tip = props.warn !== true && broken ? "This model's provider is not connected. Open the list to connect it or choose another." : props.tip;
  const toned = broken && props.problemShown !== true;
  const variant = props.variant ?? "chip";
  const side = props.side ?? "top";
  const ref = parseAcp(props.value);
  const panel = (
    <Presence show={open}>
      {open && (
        <Suspense fallback={null}>
          <ModelPickerPanel {...props} anchor={button} side={side} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </Presence>
  );

  if (variant === "field")
    return (
      <>
        <button
          ref={button}
          type="button"
          aria-label={`${props.label}: ${text}`}
          title={tip ?? `${props.label}: ${props.value}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={props.disabled}
          data-model-picker
          onClick={() => setOpen(!open)}
          className={cn(
            "flex h-row-nav w-full min-w-0 press items-center gap-1.5 rounded-sm border border-line-strong bg-raised px-3 text-left text-sm whitespace-nowrap text-fg hover:bg-hover disabled:pointer-events-none disabled:text-fg-3",
            open && "bg-active",
            toned && "text-warn",
            props.className,
          )}
        >
          <span className="min-w-0 truncate">{middleTruncate(text, 40)}</span>
          <Glyph icon={ChevronDown} size={14} className="ml-auto shrink-0 text-fg-3" />
        </button>
        {panel}
      </>
    );

  return (
    <>
      <Chip
        ref={button}
        lead={
          <Suspense fallback={<span className="size-3.5 shrink-0" />}>
            <ProviderMark id={ref ? ref.id : props.value} label={text} size={14} />
          </Suspense>
        }
        name={props.label}
        label={text}
        parts={typeof label === "string" ? chipParts(text) : null}
        bare={props.bare ?? false}
        open={open}
        disabled={props.disabled ?? false}
        warn={toned}
        aria-haspopup="dialog"
        data-model-picker
        onClick={() => setOpen(!open)}
        tip={tip}
        className={cn("max-w-60", props.className)}
      />
      {panel}
    </>
  );
}
