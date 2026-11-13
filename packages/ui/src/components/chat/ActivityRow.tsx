import { Check, ChevronRight, Circle } from "lucide-react";
import { useId, useState, type MouseEventHandler, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { formatDuration } from "../../lib/format";
import { Glyph } from "../primitives/Glyph";
import { ListRow } from "../primitives/ListRow";
import { StateGlyph } from "../primitives/StateGlyph";
import { Spinner } from "../primitives/Status";

export type ActivityState = "running" | "done" | "failed" | "stopped" | "pending";

/**
 * Decision 91d: the one row of a turn's steps (thinking, tool groups, searches, sub-agent steps, plan steps). State glyph
 * (a spinner only while it runs) · verb phrase · dim detail · duration right-aligned · a chevron only when the row
 * expands. They differ in text, never in layout. Expandable rows open `children` under the row.
 */
export function ActivityRow(props: {
  state: ActivityState;
  verb: ReactNode;
  detail?: ReactNode;
  /** Milliseconds; shown as "3s" right-aligned. */
  duration?: number | null;
  /** Rows that open take `children`; without them the row is static and shows no chevron. */
  children?: ReactNode;
  defaultOpen?: boolean;
  /** Controlled open state (the thinking row opens while it streams). */
  open?: boolean;
  onOpenChange?(open: boolean): void;
  /** Spinner without the shimmer-driving animation, for a conversation nobody is watching. */
  still?: boolean;
  /** A row that links somewhere (a sub-agent's tab) instead of opening: no chevron. */
  href?: string;
  onClick?: MouseEventHandler<HTMLElement>;
  /** Dim text before the duration (the served model, what a running agent is doing). */
  aside?: ReactNode;
  /** Tooltip with the whole row. */
  tip?: string;
  /** A row action (quiet `IconButton`s shown on hover or focus, always on touch). */
  trailing?: ReactNode;
  /** A line under the row, in the error tone (a failed step's reason). */
  error?: ReactNode;
  className?: string;
  data?: string;
}) {
  const [inner, setInner] = useState(props.defaultOpen ?? false);
  const open = props.open ?? inner;
  const id = useId();
  const expandable = props.children !== undefined && props.children !== null && props.children !== false;
  const toggle = () => {
    props.onOpenChange?.(!open);
    setInner(!open);
  };
  const leading =
    props.state === "running" ? (
      <Spinner className="text-accent" />
    ) : props.state === "failed" ? (
      <StateGlyph state="failed" size={14} />
    ) : props.state === "stopped" ? (
      <StateGlyph state="idle" size={14} />
    ) : props.state === "pending" ? (
      <Glyph icon={Circle} size={14} />
    ) : (
      <Glyph icon={Check} size={14} />
    );
  const meta = (
    <span className="flex min-w-0 items-center gap-1.5 tabular-nums">
      {props.aside !== undefined && props.aside !== null && <span className="min-w-0 truncate">{props.aside}</span>}
      {props.duration !== undefined && props.duration !== null && <span>{formatDuration(props.duration)}</span>}
      {expandable && <Glyph icon={ChevronRight} size={14} className={cn("transition-[rotate] duration-150", open && "rotate-90")} />}
    </span>
  );
  const showMeta = expandable || (props.duration !== undefined && props.duration !== null) || (props.aside !== undefined && props.aside !== null);
  return (
    <div data-activity-row={props.data ?? ""} className={cn("min-w-0", props.className)}>
      <ListRow
        tone="quiet"
        leading={leading}
        title={
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className={props.detail === undefined || props.detail === null ? "min-w-0 truncate" : "shrink-0"}>{props.verb}</span>
            {props.detail !== undefined && props.detail !== null && <span className="min-w-0 truncate text-fg-3">{props.detail}</span>}
          </span>
        }
        {...(showMeta ? { meta } : {})}
        {...(expandable ? { onClick: toggle, expanded: open } : props.onClick ? { onClick: props.onClick } : {})}
        {...(props.href ? { href: props.href } : {})}
        {...(props.tip ? { tip: props.tip } : {})}
        {...(props.trailing ? { trailing: props.trailing } : {})}
        className="-mx-2"
        {...(expandable ? { id: `${id}-row` } : {})}
      />
      {props.error && <p className="-mt-1 truncate pb-1 pl-8 text-xs text-err">{props.error}</p>}
      {expandable && open && (
        <div id={id} className="mt-1 mb-1">
          {props.children}
        </div>
      )}
    </div>
  );
}
