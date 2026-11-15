import { ArrowLeft } from "lucide-react";
import { useReducer, useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { useRowKeys } from "../../lib/hooksMore";
import { escapeTarget, paneReducer } from "../../lib/listDetail";
import { Button } from "./Button";
import { DetailBackContext } from "./Panel";
import { EmptyState } from "./EmptyState";
import { FloatRoom } from "./floatRoom";
import { ScrollArea } from "./ScrollArea";
import { SkeletonList, SkeletonText } from "./Skeleton";

/**
 * "List on the left, detail on the right" (decision 66): Memory, Notes and, later, Review, Changes, Sessions and
 * Settings → Providers. One layout so they all look and behave the same.
 *
 * - Wide (the container is at least 640px, a container query on the component itself): a list column of a fixed width
 *   (280px, `w-70`) and the detail beside it, split by ONE vertical hairline that starts at the hairline of the view tabs
 *   above. Each side scrolls on its own (`ScrollArea`).
 * - Narrow: one column. Choosing a row shows the detail under a Back control; Back returns to the list with the selection
 *   remembered (the row stays highlighted and takes focus; choosing it again reopens the detail). The list stays mounted
 *   while hidden, so its scroll position survives.
 * - Keyboard: ↑/↓/Home/End move between the list's `[data-row]` rows (Enter or Space chooses); Esc in the detail goes
 *   back to the list (one column) or moves focus to the chosen row (two columns).
 *
 * Props: `label` (the group's name), `listLabel` (the list's name and the Back control's text), `selected` (the owner's
 * remembered id, or null) with `onSelect`, `list(select)` (render the rows; call `select(id)` from a row's `onClick`),
 * `listHeader` (filters, a count: sits above the scrolling rows, inside the column), `detail` (null means nothing to show:
 * the `empty` slot, by default an `EmptyState` titled `placeholder`), `loading` with `listSkeleton` / `detailSkeleton`
 * (defaults draw rows and text lines), `detailClassName` (padding of the detail; default `px-4 pb-6`).
 *
 * Not for: a master list that opens a dialog, a settings page of independent sections, a table (`DataTable`).
 */
/** The container width (px) from which list and detail sit side by side; the `@min-[640px]/ld` classes say the same. */
const LD_SPLIT = 640;

export function ListDetail(props: {
  label: string;
  listLabel: string;
  selected: string | null;
  onSelect(id: string | null): void;
  list(select: (id: string) => void): ReactNode;
  listHeader?: ReactNode;
  detail: ReactNode | null;
  placeholder: string;
  empty?: ReactNode;
  loading?: boolean;
  listSkeleton?: ReactNode;
  detailSkeleton?: ReactNode;
  detailClassName?: string;
  /**
   * What the rows `list()` returns are: `"rows"` (default) is flat `ListRow`s, each given `role="listitem"` by the owner, inside the
   * `role="list"` the list's name goes on; `"own"` is a list the owner builds itself (a `<ul>` of `<li>`, a tree) and names.
   */
  listSemantics?: "rows" | "own";
  className?: string;
}) {
  const [pane, dispatch] = useReducer(paneReducer, props.selected, (selected) => ({ selected, open: selected !== null }));
  // The owner moved the selection itself (a search hit): computed while rendering, not in an effect (rule 12).
  if (pane.selected !== props.selected) dispatch({ type: "sync", selected: props.selected });
  const hasDetail = props.detail !== null;
  const open = pane.open && hasDetail;
  const rows = useRef<HTMLDivElement>(null);
  const outer = useRef<HTMLDivElement>(null);
  useRowKeys(rows);

  const focusList = () =>
    requestAnimationFrame(() => {
      const el = rows.current;
      if (!el) return;
      const chosen = el.querySelector<HTMLElement>('[data-row][aria-current="true"], [data-row][aria-selected="true"]');
      (chosen ?? el.querySelector<HTMLElement>("[data-row]"))?.focus();
    });
  const goBack = () => {
    dispatch({ type: "back" });
    focusList();
  };
  const select = (id: string) => {
    dispatch({ type: "pick", id });
    props.onSelect(id);
  };
  const onDetailKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    // One column below the container query's 640px (B29: decided by the width, not by whether a Back row is drawn — a
    // `DetailHeader` carries its own Back control and hides that row).
    const narrow = (outer.current?.clientWidth ?? Infinity) < LD_SPLIT;
    e.preventDefault();
    e.stopPropagation();
    if (escapeTarget(narrow) === "back") goBack();
    else focusList();
  };

  return (
    // The container query lives on the outer element: a container cannot match its own query, so the row layout is on the inner one.
    <div ref={outer} className={cn("@container/ld h-full min-h-0", props.className)}>
      <div role="group" aria-label={props.label} className="flex h-full min-h-0 flex-col @min-[640px]/ld:flex-row">
        <div
          // P7: nothing chosen yet. A list that pre-opens its first item beside it (wide) marks that row; one column shows no detail, so no row reads as chosen (styles.css).
          data-unpicked={props.selected === null || undefined}
          className={cn(
            "min-h-0 flex-col @min-[640px]/ld:flex @min-[640px]/ld:w-70 @min-[640px]/ld:shrink-0 @min-[640px]/ld:border-r @min-[640px]/ld:border-line",
            open ? "hidden" : "flex flex-1 @min-[640px]/ld:flex-none",
          )}
        >
          {props.listHeader}
          <ScrollArea className="min-h-0 flex-1 px-pane pt-1 pb-4">
            <div ref={rows} {...(props.listSemantics === "own" || props.loading ? {} : { role: "list", "aria-label": props.listLabel })}>
              {props.loading ? (props.listSkeleton ?? <SkeletonList count={7} size="md" twoLine />) : props.list(select)}
            </div>
            <FloatRoom />
          </ScrollArea>
        </div>
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Esc from any control inside the detail goes back (decision 66) */}
        <section
          aria-label="Detail"
          aria-busy={props.loading || undefined}
          onKeyDown={onDetailKey}
          className={cn("group/detail min-h-0 min-w-0 flex-1 flex-col @min-[640px]/ld:flex", open ? "flex" : "hidden")}
        >
          {/* A `DetailHeader` in the detail carries its own Back control (decision 95f): then this row is not drawn. */}
          <div className="flex h-ctl-md shrink-0 items-center px-pane group-has-[[data-detail-header]]/detail:hidden @min-[640px]/ld:hidden">
            <Button variant="quiet" size="sm" icon={ArrowLeft} onClick={goBack}>
              {props.listLabel}
            </Button>
          </div>
          {props.loading ? (
            <div className={cn("px-4 pt-4", !open && "hidden @min-[640px]/ld:block")}>{props.detailSkeleton ?? <SkeletonText lines={5} />}</div>
          ) : hasDetail ? (
            <ScrollArea className={cn("min-h-0 flex-1", props.detailClassName ?? "px-pane pb-6")}>
              <DetailBackContext value={{ back: goBack, label: props.listLabel }}>{props.detail}</DetailBackContext>
              <FloatRoom />
            </ScrollArea>
          ) : (
            (props.empty ?? <EmptyState title={props.placeholder} />)
          )}
        </section>
      </div>
    </div>
  );
}
