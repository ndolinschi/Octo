import { Check, ChevronRight, Circle } from "lucide-react";
import { useEffect, useId, useState, type MouseEventHandler, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { formatDuration } from "../../lib/format";
import { Glyph } from "../primitives/Glyph";
import { ListRow } from "../primitives/ListRow";
import { StateGlyph } from "../primitives/StateGlyph";
import { Spinner } from "../primitives/Status";

export type ActivityState = "running" | "done" | "failed" | "stopped" | "pending" | "needs";

/**
 * Decision 91d: the one row of a turn's steps (thinking, tool groups, searches, sub-agent steps, plan steps). State glyph
 * (a spinner only while it runs; every glyph 14) · verb phrase · dim detail · a chevron right after the text when the row
 * expands (polish step 3, C2: the affordance sits where the eye is, not at the far edge) · duration right-aligned in meta
 * style. They differ in text, never in layout. Expandable rows open `children` under the row; a row with `expands` toggles
 * something rendered elsewhere (the "Worked for…" head opens the turn's steps in place).
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
  /** The row toggles (`open` / `onOpenChange`) without `children` of its own. */
  expands?: boolean;
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
  /** The trailing action shows at all times (Retry on a failed row). */
  trailingShown?: boolean;
  /** A line under the row, in the error tone (a failed step's reason). */
  error?: ReactNode;
  /** A dim line under the row (why a step failed, in words; the glyph carries the tone). */
  note?: ReactNode;
  className?: string;
  data?: string;
  /** Direction 7 (phone): the detail goes on a second line under the verb, so neither is cut to fit the other. */
  stacked?: boolean;
}) {
  const [inner, setInner] = useState(props.defaultOpen ?? false);
  const open = props.open ?? inner;
  const id = useId();
  const nested = props.children !== undefined && props.children !== null && props.children !== false;
  const expandable = nested || props.expands === true;
  const [prevOpen, setPrevOpen] = useState(open);
  const [entering, setEntering] = useState(false);
  const [leaving, setLeaving] = useState(false);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (nested) {
      if (open) {
        setLeaving(false);
        setEntering(true);
      } else {
        setEntering(false);
        setLeaving(true);
      }
    }
  }
  useEffect(() => {
    if (!entering) return;
    let cancel = false;
    let innerRaf = 0;
    const outerRaf = requestAnimationFrame(() => {
      innerRaf = requestAnimationFrame(() => {
        if (!cancel) setEntering(false);
      });
    });
    return () => {
      cancel = true;
      cancelAnimationFrame(outerRaf);
      cancelAnimationFrame(innerRaf);
    };
  }, [entering]);
  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(() => setLeaving(false), 200);
    return () => window.clearTimeout(t);
  }, [leaving]);
  const mounted = nested && (open || leaving);
  const shown = open && !entering;
  const toggle = () => {
    props.onOpenChange?.(!open);
    setInner(!open);
  };
  const leading =
    props.state === "running" ? (
      <Spinner size={14} className="text-accent" />
    ) : props.state === "failed" ? (
      <StateGlyph state="failed" size={14} />
    ) : props.state === "stopped" ? (
      // R2 (design study B d): the ring with a square, as heavy as ⊘ and ! beside it (idle's dot read as idle).
      <StateGlyph state="stopped" size={14} />
    ) : props.state === "needs" ? (
      <StateGlyph state="needs" size={14} />
    ) : props.state === "pending" ? (
      <Glyph icon={Circle} size={14} />
    ) : (
      <Glyph icon={Check} size={14} />
    );
  // Balance pass: a hover-only action (a helper's "Open session") takes the meta's place on hover, as the sidebar tree's do,
  // instead of reserving its width on every row: the durations of a delegation group and the live row under it stay in one
  // column. A stacked (phone) row and a row whose action always shows keep it in the row.
  const overlay = props.trailing !== undefined && props.trailing !== null && !props.trailingShown && !props.stacked;
  const meta = (
    <span data-row-meta={overlay || undefined} className="flex min-w-0 items-center gap-1.5 tabular-nums">
      {props.aside !== undefined && props.aside !== null && <span className="min-w-0 truncate">{props.aside}</span>}
      {props.duration !== undefined && props.duration !== null && <span>{formatDuration(props.duration)}</span>}
    </span>
  );
  const showMeta = (props.duration !== undefined && props.duration !== null) || (props.aside !== undefined && props.aside !== null);
  const clickable = expandable || Boolean(props.onClick) || Boolean(props.href);
  return (
    <div data-activity-row={props.data ?? ""} data-row-overlay={overlay || undefined} className={cn("min-w-0", props.className)}>
      <ListRow
        tone="quiet"
        hover="text"
        leading={leading}
        title={
          <span className="flex min-w-0 items-center gap-1">
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className={props.detail === undefined || props.detail === null || props.stacked ? "min-w-0 truncate" : "shrink-0"}>{props.verb}</span>
              {!props.stacked && props.detail !== undefined && props.detail !== null && (
                <span className={cn("min-w-0 truncate text-fg-3", clickable && "transition-colors group-hover:text-fg-2")}>{props.detail}</span>
              )}
            </span>
            {expandable && (
              <Glyph
                icon={ChevronRight}
                size={14}
                className={cn("shrink-0 text-fg-3 transition-[rotate,color] duration-base group-hover:text-fg-2", open && "rotate-90")}
              />
            )}
          </span>
        }
        {...(showMeta ? { meta } : {})}
        {...(props.stacked && props.detail !== undefined && props.detail !== null ? { description: props.detail } : {})}
        {...(expandable ? { onClick: toggle, expanded: open } : props.onClick ? { onClick: props.onClick } : {})}
        {...(props.href ? { href: props.href } : {})}
        {...(props.tip ? { tip: props.tip } : {})}
        {...(props.trailing && !overlay ? { trailing: props.trailing, trailingShown: props.trailingShown } : {})}
        className="-mx-2"
        {...(expandable ? { id: `${id}-row` } : {})}
      />
      {overlay && <span data-row-actions>{props.trailing}</span>}
      {/* On the row's text line (16 glyph + 8 gap), as what a row opens: it stood 8px right of the text it explains. */}
      {props.error && <p className="-mt-1 truncate pb-1 pl-6 text-xs text-err">{props.error}</p>}
      {props.note && <p className="-mt-1 truncate pb-1 pl-6 text-xs text-fg-3">{props.note}</p>}
      {mounted && (
        <div data-activity-drawer data-open={shown || undefined} inert={!shown || undefined} aria-hidden={!shown || undefined} className="octo-drawer-rows">
          <div className="min-h-0 overflow-hidden">
            {/* C1: a subtle tree guide under the parent's glyph center (8px) with 16px indent puts nested content on the parent's text line. */}
            <div id={id} data-activity-body className="mt-0.5 mb-2 ml-2 flex flex-col gap-0.5 border-l border-line pl-4">
              {props.children}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
