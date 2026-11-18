import { ArrowLeft } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { PANEL_COLUMN } from "../../lib/panelColumn";
import { EmptyState } from "./EmptyState";
import { IconButton } from "./IconButton";
import { FloatRoom } from "./floatRoom";
import { ScrollArea } from "./ScrollArea";

/**
 * Decision 95f: the one frame of every tool tab (Sessions, Memory, Notes, Usage, Agents, Details, Changes; the Files list
 * and the Review picker later). A screen supplies content; the frame owns every inset and gap, so no tab sets its own outer
 * padding or header.
 *
 * Top to bottom (each part is optional except the header):
 * 1. header: 40px line with a `line` hairline under it (as the Files bar), title at the left, the `actions` at the right (one height, one baseline). The primary action is a
 *    quiet or secondary `Button` of size sm; `meta` is a dim count or state after the title.
 * 2. `filters`: at most one row of 36px, `FilterTabs` first, then a `SearchField` (`PanelFilters`). It may also be a
 *    `ListDetail`'s `listHeader`, so it sits over the list column only.
 * 3. `views`: a `ViewTabs` row (decision 82) with its own hairline. Content under the header draws no top line of its own.
 * 4. the content: a `ListDetail`, or `PanelBody` for one scrolling column.
 * 5. `footer`: one dim line.
 *
 * Insets: edges at 8px (`px-pane`), text at 16px (the label of a `ListRow`: 8 + 8). Title, filter chips, section headers and
 * the detail header's title all start at 16, so one vertical line runs through the whole tab. Rows are 32px (40 with a
 * second line). The gap from the header or the filter row to the first row is 4px.
 *
 * `name` marks the root (`data-panel`) for the spacing audit's "panel-frame" check. Not for: the chat, a code editor, a page
 * (Settings, Home), a dialog.
 */
export function Panel(props: {
  name: string;
  title: string;
  meta?: ReactNode;
  /**
   * Controls that qualify the title (the review picker's repository menu): between the title and the actions, they give way
   * first (the title keeps its width). Polish step 6b.
   */
  lead?: ReactNode;
  actions?: ReactNode;
  /** A problem to say once, above everything else (an action's error). */
  notice?: ReactNode;
  filters?: ReactNode;
  views?: ReactNode;
  footer?: ReactNode;
  /** Cap header, notice, and footer to the single-column measure (`PANEL_COLUMN`) so right edges align across the tab. */
  column?: "measure";
  children: ReactNode;
  className?: string;
}) {
  const measure = props.column === "measure" ? PANEL_COLUMN : undefined;
  return (
    <section data-panel={props.name} aria-label={props.title} className={cn("flex h-full min-h-0 flex-col", props.className)}>
      {/* The bar's hairline runs the tab's full width (like the Files and Browser bars), also when the header is capped. */}
      <div data-panel-bar className="shrink-0 shadow-[inset_0_-1px_0_var(--octo-line)]">
        <header data-panel-header className={cn("flex h-ctl-lg shrink-0 items-center gap-2 px-pane", measure)}>
          <h2 data-panel-title className={cn("flex min-w-0 items-baseline gap-2 px-2 text-heading text-fg", props.lead === undefined ? "flex-1" : "shrink-0")}>
            <span className="truncate">{props.title}</span>
            {props.meta !== undefined && <span className="shrink-0 text-xs font-normal text-fg-3 tabular-nums">{props.meta}</span>}
          </h2>
          {props.lead !== undefined && (
            <div data-panel-lead className="flex min-w-0 flex-1 items-center gap-1">
              {props.lead}
            </div>
          )}
          {props.actions !== undefined && (
            <div data-panel-actions className="flex shrink-0 items-center gap-1">
              {props.actions}
            </div>
          )}
        </header>
      </div>
      {props.notice !== undefined && <div className={cn("shrink-0 px-pane pb-2", measure)}>{props.notice}</div>}
      {props.filters !== undefined && props.filters}
      {props.views}
      <div data-panel-body className="relative min-h-0 flex-1">
        {props.children}
      </div>
      {props.footer !== undefined && (
        // R2: a hairline over the footer, so the list's last row ends on an edge instead of under a loose caption.
        <p data-panel-footer className={cn("line-clamp-2 shrink-0 border-t border-line px-4 py-1.5 text-xs text-fg-3", measure)}>
          {props.footer}
        </p>
      )}
    </section>
  );
}

/** The filter row: `FilterTabs` (with `bare`) first, then a search, 8px apart, centred in 36px. */
export function PanelFilters(props: { children: ReactNode; /** Inside a scroller that already has the 8px inset. */ flush?: boolean; className?: string }) {
  return (
    <div data-panel-filters className={cn("flex min-h-9 shrink-0 items-center gap-2 touch:min-h-ctl-lg", !props.flush && "px-pane", props.className)}>
      {props.children}
    </div>
  );
}

/** One scrolling column for a tab that is not a list and a detail: the frame's list inset, rows left-aligned at every width. */
export function PanelBody(props: {
  children: ReactNode;
  className?: string;
  fade?: boolean;
  ref?: React.Ref<HTMLDivElement>;
  onScroll?: React.UIEventHandler<HTMLDivElement>;
}) {
  return (
    <ScrollArea
      {...(props.ref ? { ref: props.ref } : {})}
      {...(props.onScroll ? { onScroll: props.onScroll } : {})}
      fade={props.fade ?? false}
      className={cn("h-full min-h-0 px-pane pt-1 pb-4", props.className)}
    >
      {props.children}
      <FloatRoom />
    </ScrollArea>
  );
}

/**
 * P1 (polish step 5): the one empty state of a tool tab, in two forms.
 * - With a `title`: the whole tab (or the whole body under its filter row / view tabs) has nothing to show. A composed
 *   block (`EmptyState`) centred in the body at the frame's one position (its centre at 42 % of the free height): the title,
 *   one line of explanation, and the action where there is one. Put it as the direct child of the `Panel` (or of a flex
 *   column that owns the body's height), never inside a scroller.
 * - Without a title: one dim sentence inside a list or a section that has nothing to show (a filter with no match), on the
 *   rows' text edge.
 */
export function PanelEmpty(props: { title?: string; children?: ReactNode; actions?: ReactNode }) {
  if (props.title !== undefined)
    return (
      <div data-panel-empty-block className="flex h-full min-h-0 flex-col">
        <EmptyState title={props.title} actions={props.actions}>
          {props.children}
        </EmptyState>
      </div>
    );
  return (
    <p role="status" data-panel-empty className="px-2 pt-3 text-sm text-fg-3">
      {props.children}
    </p>
  );
}

/**
 * P2 (polish step 5): the one action row that ends every editor (a note, a memory file, "Remember something") and every
 * inline confirmation: at the right, Cancel then the primary, small buttons 8 apart. `note` is a sentence at the left (the
 * question of a confirmation); with it the row is an `alertdialog` named by `label`.
 */
export function FormActions(props: { children: ReactNode; note?: ReactNode; label?: string; className?: string }) {
  const confirm = props.note !== undefined;
  return (
    <div
      data-form-actions
      {...(confirm ? { role: "alertdialog", "aria-label": props.label } : {})}
      className={cn("flex min-w-0 flex-wrap items-center justify-end gap-2 text-sm", props.className)}
    >
      {confirm && <span className="min-w-0 flex-1 text-fg-2">{props.note}</span>}
      {props.children}
    </div>
  );
}

/** What `ListDetail` hands its detail so the header can carry the Back control in one column. */
export const DetailBackContext = createContext<{ back(): void; label: string } | null>(null);

/**
 * The one detail header: Back (one column only) · title · a dim meta line · actions at the right, the "⋯" last. The title
 * wraps; the first line and the actions share one 28px line, so a button sits on the title's baseline. Inside `ListDetail`
 * it replaces the Back row `ListDetail` draws on its own.
 */
export function DetailHeader(props: { title: ReactNode; meta?: ReactNode; actions?: ReactNode; className?: string }) {
  const back = useContext(DetailBackContext);
  return (
    <header data-detail-header className={cn("flex min-w-0 items-start gap-2 pt-2 pb-2", props.className)}>
      {back && (
        <span className="flex h-ctl-sm shrink-0 items-center @min-[640px]/ld:hidden phone:h-ctl-lg">
          <IconButton icon={ArrowLeft} label={`Back to ${back.label}`} size="sm" onClick={back.back} />
        </span>
      )}
      <div className="min-w-0 flex-1 px-2">
        <div className="flex min-h-ctl-sm items-center">
          <h2 className="min-w-0 text-heading break-words text-fg">{props.title}</h2>
        </div>
        {props.meta !== undefined && <p className="truncate text-xs text-fg-3">{props.meta}</p>}
      </div>
      {props.actions !== undefined && <div className="flex h-ctl-sm shrink-0 items-center gap-1 phone:min-h-ctl-lg">{props.actions}</div>}
    </header>
  );
}
