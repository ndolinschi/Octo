import { CircleHelp } from "lucide-react";
import { useId, type ReactNode, type SelectHTMLAttributes } from "react";
import { cn } from "../../lib/cn";
import { Glyph } from "../primitives/Glyph";
import { Spinner } from "../primitives/Status";
import type { SaveState } from "./useSave";

/**
 * Decision 59 anatomy: a 12px group label above a card (panel surface, radius 10, hairlines between rows); a row is a
 * title and a one-line description on the left and exactly one control on the right, 56px or more tall. Below the
 * settings breakpoint (760px) the control goes under the text.
 */
export function SettingsGroup(props: { label: string; children: ReactNode; id?: string | undefined; footer?: ReactNode }) {
  const labelId = useId();
  return (
    <section aria-labelledby={labelId} id={props.id} className="flex flex-col gap-2">
      <h2 id={labelId} className="px-1 text-xs text-fg-3">
        {props.label}
      </h2>
      <div className="flex flex-col divide-y divide-line overflow-hidden rounded-lg border border-panel-edge bg-panel shadow-panel">{props.children}</div>
      {props.footer && <div className="px-1 text-xs text-fg-3">{props.footer}</div>}
    </section>
  );
}

export function SettingsRow(props: {
  title: ReactNode;
  description?: ReactNode;
  /** The one control. */
  control?: ReactNode;
  /** "Saved", "Restart required", an error: one line under the description. */
  status?: ReactNode;
  /** A long explanation behind a "?" (decision 59). */
  help?: string | undefined;
  /** The `id` of the control, so the title is its label. */
  htmlFor?: string | undefined;
  /** Anchor for search results (`#row-<id>`). */
  rowId?: string;
  leading?: ReactNode;
  className?: string;
}) {
  return (
    <div
      id={props.rowId ? `row-${props.rowId}` : undefined}
      data-settings-row
      className={cn(
        "flex min-h-14 scroll-mt-6 items-center gap-4 px-4 py-3 max-settings:flex-col max-settings:items-stretch max-settings:gap-3",
        props.className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {props.leading}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            {props.htmlFor ? (
              <label htmlFor={props.htmlFor} className="min-w-0 text-base break-words text-fg">
                {props.title}
              </label>
            ) : (
              <span className="min-w-0 text-base break-words text-fg">{props.title}</span>
            )}
            {props.help && (
              <button
                type="button"
                aria-label="More about this setting"
                title={props.help}
                className="grid size-6 shrink-0 place-items-center rounded-sm text-fg-3 hover:bg-hover hover:text-fg"
              >
                <Glyph icon={CircleHelp} size={14} />
              </button>
            )}
          </div>
          {props.description && <div className="text-sm break-words text-fg-3">{props.description}</div>}
          {props.status}
        </div>
      </div>
      {props.control && <div className="flex shrink-0 items-center justify-end gap-2 max-settings:justify-start">{props.control}</div>}
    </div>
  );
}

/** The line a row shows after a change (decision 59: every change says "Saved"; a restart says so with a button). */
export function SaveStatus(props: { state: SaveState; restart?: boolean; onRestart?: (() => void) | undefined }) {
  const { state } = props;
  if (state.kind === "saving")
    return (
      <p role="status" className="mt-1 flex items-center gap-1.5 text-xs text-fg-3">
        <Spinner size={10} /> Saving…
      </p>
    );
  if (state.kind === "error")
    return (
      <p role="alert" className="mt-1 text-xs text-err">
        {state.message}
      </p>
    );
  if (props.restart)
    return (
      <p role="status" className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-warn">
        Saved. Applies after a restart.
        {props.onRestart ? (
          <button type="button" onClick={props.onRestart} className="rounded-xs text-link underline-offset-2 hover:underline">
            Restart now
          </button>
        ) : (
          <span className="text-fg-3">Quit and reopen the app.</span>
        )}
      </p>
    );
  if (state.kind === "saved")
    return (
      <p role="status" className="mt-1 text-xs text-ok">
        Saved
      </p>
    );
  return null;
}

/** On/off (`role="switch"`), 40×24 with a 20px knob. */
export function Switch(props: { checked: boolean; onChange(next: boolean): void; label: string; id?: string; disabled?: boolean }) {
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
        "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full border border-transparent transition-[background-color] duration-150 disabled:opacity-50",
        props.checked ? "bg-primary" : "bg-active",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute top-0.5 left-0.5 size-5 rounded-full shadow-float transition-[translate] duration-150 ease-out-quint",
          props.checked ? "translate-x-4 bg-primary-fg" : "bg-fg-2",
        )}
      />
    </button>
  );
}

/** A native select styled as a 32px control (decision 59 "select"); keeps the platform's own list and keyboard. */
export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "h-8 max-w-full min-w-0 rounded-md border border-input-border bg-panel pr-8 pl-3 text-sm text-fg transition-[border-color] duration-100 focus:border-fg focus:outline-none focus-visible:shadow-none max-settings:w-full",
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
}

/** A row while its data loads: the same height, two muted bars, no spinner jump. */
export function SkeletonRow() {
  return (
    <div aria-hidden className="flex min-h-14 items-center gap-4 px-4 py-3">
      <div className="flex flex-1 flex-col gap-2">
        <span className="h-3 w-2/5 rounded-full bg-hover" />
        <span className="h-2 w-3/5 rounded-full bg-hover" />
      </div>
      <span className="h-6 w-16 rounded-sm bg-hover" />
    </div>
  );
}

/** A state dot for a provider or agent (ok / warn / err / muted). */
export function StateDot({ tone }: { tone: "ok" | "warn" | "err" | "muted" }) {
  return (
    <span
      aria-hidden
      className={cn("size-2 shrink-0 rounded-full", tone === "ok" ? "bg-ok" : tone === "warn" ? "bg-warn" : tone === "err" ? "bg-err" : "bg-fg-3")}
    />
  );
}
