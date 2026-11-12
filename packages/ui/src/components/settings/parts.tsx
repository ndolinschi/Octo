import { CircleHelp } from "lucide-react";
import { useId, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Button } from "../primitives/Button";
import { ListFrame } from "../primitives/Card";
import { IconButton } from "../primitives/IconButton";
import { Notice } from "../primitives/Notice";
import { SectionHeader } from "../primitives/SectionHeader";
import { Spinner } from "../primitives/Status";
import type { SaveState } from "./useSave";

/** Widths of the control of a settings row (layout only); under the settings breakpoint the control fills the row. */
export const CONTROL_W = {
  sm: "w-32 max-settings:w-full",
  md: "w-48 max-settings:w-full",
  lg: "w-64 max-settings:w-full",
} as const;

/**
 * Decision 59 anatomy on the library (decision 90): a `SectionHeader` over a `ListFrame` of rows; a row is a title and a
 * one-line description on the left and exactly one control on the right, 56px or more tall. Below the settings breakpoint
 * (760px) the control goes under the text.
 */
export function SettingsGroup(props: { label: string; children: ReactNode; id?: string | undefined; footer?: ReactNode; aside?: ReactNode }) {
  const labelId = useId();
  return (
    <section aria-labelledby={labelId} id={props.id} className="flex flex-col gap-2">
      <SectionHeader id={labelId} inset aside={props.aside}>
        {props.label}
      </SectionHeader>
      <ListFrame>{props.children}</ListFrame>
      {props.footer && <div className="px-2 text-xs text-fg-3">{props.footer}</div>}
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
            {props.help && <IconButton icon={CircleHelp} label="More about this setting" size="xs" title={props.help} />}
          </div>
          {props.description && <div className="text-sm break-words text-fg-3">{props.description}</div>}
          {props.status}
        </div>
      </div>
      {props.control && <div className="flex shrink-0 items-center justify-end gap-2 max-settings:justify-start">{props.control}</div>}
    </div>
  );
}

/** A row that says why a load failed and how to go on: the one shape of "Couldn't load X" in Settings. */
export function LoadErrorRow(props: { what: string; message: string; hint: string; onRetry(): void }) {
  return (
    <SettingsRow
      title={
        <Notice tone="error" className="text-base">
          Couldn&apos;t load {props.what}
        </Notice>
      }
      description={`${props.message}. ${props.hint}`}
      control={
        <Button size="sm" onClick={props.onRetry}>
          Retry
        </Button>
      }
    />
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
      <Notice tone="error" className="mt-1">
        {state.message}
      </Notice>
    );
  if (props.restart)
    return (
      <Notice
        tone="warn"
        className="mt-1"
        action={
          props.onRestart ? (
            <Button variant="link" size="xs" onClick={props.onRestart}>
              Restart now
            </Button>
          ) : (
            <span className="text-fg-3">Quit and reopen the app.</span>
          )
        }
      >
        Saved. Applies after a restart.
      </Notice>
    );
  if (state.kind === "saved")
    return (
      <Notice tone="success" className="mt-1">
        Saved
      </Notice>
    );
  return null;
}
