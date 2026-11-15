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

/** S2: every select in a settings row is this one width (the model names need it; a short list reads the same), and every row control is 28px tall (`size="sm"`; a switch 24). */
export const SELECT_W = CONTROL_W.lg;

/**
 * Polish trial T5 (widths by meaning): the one cap for the fields of a `FieldRow` inside a settings pane (the provider's
 * preferred model and roles): columns of at most 16rem, the same 256px as `CONTROL_W.lg`, so a select is as wide as its
 * content needs, never the page, and a one-field row lines up with the first column of a three-field row. Set on the pane
 * that holds the rows (an `@container`); below the container's `md` width the fields stack and fill the row (`FieldRow`).
 */
export const CONTROL_CAP = "@md:[&_[data-field-row]]:grid-cols-[repeat(3,minmax(0,16rem))]";

/**
 * Decision 59 anatomy on the library, composed by polish step 6a (S1): a group is a caption (meta) over one surface
 * (`ListFrame`) that holds its rows, and an optional meta note under it. Caption, row labels and the note share one left edge
 * (`settings-inset`, the rows' own padding), the same edge as the page title. Below the settings breakpoint (760px) a row's
 * control goes under its text.
 */
export function SettingsGroup(props: {
  /** The caption; leave it out when the page title already names the only group (Remote access), and give `name` instead. */
  label?: ReactNode;
  /** The group's accessible name when it has no caption. */
  name?: string;
  children: ReactNode;
  id?: string | undefined;
  footer?: ReactNode;
  /** One meta line between the caption and the surface: what the group's rows are (Integrations). */
  description?: ReactNode;
  aside?: ReactNode;
}) {
  const labelId = useId();
  const captioned = props.label !== undefined;
  return (
    <section
      {...(captioned ? { "aria-labelledby": labelId } : props.name ? { "aria-label": props.name } : {})}
      id={props.id}
      className="flex scroll-mt-6 flex-col gap-1"
    >
      {/* The side columns' caption rule on the page: a 20px line, 4px over its surface, on the rows' text edge. */}
      {captioned && (
        <SectionHeader id={labelId} aside={props.aside} line="tight" className="px-settings-inset">
          {props.label}
        </SectionHeader>
      )}
      {/* The rows' reading measure (SettingsRow's 56ch) plus the inset on both sides. */}
      {props.description && <p className="max-w-[59ch] px-settings-inset pb-1 text-xs text-pretty text-fg-3">{props.description}</p>}
      <ListFrame>{props.children}</ListFrame>
      {props.footer && <div className="max-w-[59ch] px-settings-inset pt-1 text-xs text-pretty text-fg-3">{props.footer}</div>}
    </section>
  );
}

/**
 * S2: one anatomy for every settings row. The label (content, 14px) and one explanation line under it (meta, 12px `fg-3`) on
 * the left; the control at the right, centred on the label's first line, its right edge the row's edge; the save status
 * ("Saving…", "Saved", a restart, an error) in the control line just left of the control, so a save never changes the row's
 * height. 60px for a label and one explanation line; a row with no explanation keeps 60 and centres its one line.
 */
export function SettingsRow(props: {
  title: ReactNode;
  description?: ReactNode;
  /** The one control. */
  control?: ReactNode;
  /** `SaveStatus`: shown in the control line, left of the control. */
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
  const one = props.description === undefined || props.description === null || props.description === "";
  return (
    <div
      id={props.rowId ? `row-${props.rowId}` : undefined}
      data-settings-row
      className={cn(
        "flex min-h-settings-row scroll-mt-6 gap-4 px-settings-inset py-3 max-settings:flex-col max-settings:items-stretch max-settings:gap-2",
        one ? "items-center" : "items-start",
        props.className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {props.leading && <span className="flex h-5 shrink-0 items-center">{props.leading}</span>}
        <div className="min-w-0 flex-1">
          <div className="flex min-h-5 min-w-0 items-center gap-1.5">
            {props.htmlFor ? (
              <label htmlFor={props.htmlFor} data-settings-label className="min-w-0 text-base/5 break-words text-fg">
                {props.title}
              </label>
            ) : (
              <span data-settings-label className="min-w-0 text-base/5 break-words text-fg">
                {props.title}
              </span>
            )}
            {props.help && <IconButton icon={CircleHelp} label="More about this setting" size="xs" title={props.help} className="-my-0.5" />}
          </div>
          {/* The row spans the 880 column; its explanation keeps a reading measure (~75 characters of 12px Inter) instead. */}
          {!one && <div className="max-w-[56ch] text-xs text-pretty break-words text-fg-3">{props.description}</div>}
        </div>
      </div>
      {(props.control || props.status) && (
        <div
          data-settings-control
          className="flex h-5 shrink-0 items-center justify-end gap-3 max-settings:h-auto max-settings:min-h-5 max-settings:flex-wrap max-settings:justify-start"
        >
          {props.status && <span className="flex min-w-0 items-center empty:hidden max-settings:order-last">{props.status}</span>}
          {props.control}
        </div>
      )}
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

/**
 * What a row says after a change (decision 59: every change says "Saved"; a restart says so with a button). S2: one short
 * line that sits in the row's control line (or under a `FieldRow`), never a line that grows the row; an error keeps its
 * sentence and wraps inside 16rem.
 */
export function SaveStatus(props: { state: SaveState; restart?: boolean; onRestart?: (() => void) | undefined }) {
  const { state } = props;
  if (state.kind === "saving")
    return (
      <p role="status" className="flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap text-fg-3">
        <Spinner size={10} /> Saving…
      </p>
    );
  if (state.kind === "error")
    return (
      <Notice tone="error" className="max-w-64">
        {state.message}
      </Notice>
    );
  if (props.restart)
    return (
      <Notice
        tone="warn"
        className="shrink-0 whitespace-nowrap"
        action={
          props.onRestart ? (
            <Button variant="link" size="xs" onClick={props.onRestart}>
              Restart now
            </Button>
          ) : undefined
        }
      >
        {props.onRestart ? "Saved · applies after a restart" : "Saved · quit and reopen the app to apply"}
      </Notice>
    );
  if (state.kind === "saved")
    return (
      <Notice tone="success" className="shrink-0 whitespace-nowrap">
        Saved
      </Notice>
    );
  return null;
}
