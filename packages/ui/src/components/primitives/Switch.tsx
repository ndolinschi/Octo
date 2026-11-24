import { cn } from "../../lib/cn";

/**
 * On/off (`role="switch"`), 40x24 with a 20px knob (decision 59; moved here from `settings/parts`, same props). It applies
 * at once: no "Save" step. `label` is the accessible name (ignored when `id` points a visible `<label>` at it). Grows a 40px
 * hit area on touch. The knob is the only motion (`--motion-base`), and it is a state change, not an idle animation.
 *
 * Not for: a choice that is submitted with a form (`Checkbox`), more than two states (`Segmented`).
 */
export function Switch(props: { checked: boolean; onChange(next: boolean): void; label: string; id?: string; disabled?: boolean; className?: string }) {
  return (
    <button
      type="button"
      role="switch"
      id={props.id}
      aria-checked={props.checked}
      aria-label={props.id ? undefined : props.label}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
      className={cn(
        "touch-hit relative inline-flex h-ctl-xs w-ctl-lg shrink-0 items-center rounded-full transition-[background-color,box-shadow] duration-base disabled:opacity-50",
        props.checked ? "bg-primary" : "bg-active shadow-[inset_0_0_0_1px_var(--octo-input-border)]",
        // 6d: forced colours drop both fills; the track gets an edge, and on is the system's highlight.
        "forced-colors:outline forced-colors:outline-1 forced-colors:outline-[CanvasText] forced-colors:forced-color-adjust-none",
        props.checked ? "forced-colors:bg-[Highlight]" : "forced-colors:bg-[Canvas]",
        props.className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute top-0.5 left-0.5 size-5 rounded-full shadow-float transition-[translate] duration-base ease-out-quint forced-color-adjust-none",
          props.checked ? "translate-x-4 bg-primary-fg forced-colors:bg-[HighlightText]" : "bg-fg-2 forced-colors:bg-[CanvasText]",
        )}
      />
    </button>
  );
}
