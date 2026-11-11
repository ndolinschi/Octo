import { ArrowLeft } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { useRowKeys } from "../../lib/hooks";
import { Button } from "../primitives/Button";
import { INFO_ROW, SkeletonRows } from "../primitives/InfoList";

/**
 * List and detail. Wide (the view is 640px or more): the list on the left (a third, 220 to 320px), the detail beside
 * it, each scrolling by itself. Narrow: one column; the detail replaces the list under a Back button, and the list's
 * scroll position survives (the list stays mounted, hidden).
 */
export function ListDetail(props: {
  label: string;
  /** What the list is called for the screen reader, and the Back button's target. */
  listLabel: string;
  list: ReactNode;
  /** The header row of the list column (filters, counts). */
  listHeader?: ReactNode;
  detail: ReactNode | null;
  onBack(): void;
  /** What the detail pane says when nothing is chosen (wide layout only). */
  placeholder: string;
}) {
  const open = props.detail !== null;
  return (
    <div role="group" aria-label={props.label} className="flex h-full min-h-0 flex-col @min-[640px]/memory:flex-row">
      <section
        aria-label={props.listLabel}
        className={cn(
          "flex min-h-0 flex-col @min-[640px]/memory:w-[clamp(220px,34%,320px)] @min-[640px]/memory:shrink-0 @min-[640px]/memory:border-r @min-[640px]/memory:border-line",
          open ? "hidden @min-[640px]/memory:flex" : "flex-1 @min-[640px]/memory:flex-none",
        )}
      >
        {props.listHeader}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-pane pb-4">{props.list}</div>
      </section>
      <section aria-label="Detail" className={cn("min-h-0 min-w-0 flex-1 flex-col", open ? "flex" : "hidden @min-[640px]/memory:flex")}>
        {props.detail === null ? (
          <p className="px-4 py-3 text-sm text-fg-3">{props.placeholder}</p>
        ) : (
          <>
            <div className="flex h-row shrink-0 items-center px-pane @min-[640px]/memory:hidden">
              <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={props.onBack}>
                {props.listLabel}
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6">{props.detail}</div>
          </>
        )}
      </section>
    </div>
  );
}

/** A rows container: ↑/↓/Home/End move between its `[data-row]` buttons. */
export function RowList({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLUListElement>(null);
  useRowKeys(ref);
  return (
    <ul ref={ref} aria-label={label} className={cn("flex flex-col", className)}>
      {children}
    </ul>
  );
}

/** A caption (12px, fg-3) over its content. */
export function Block(props: { title: string; children: ReactNode; aside?: ReactNode; id?: string }) {
  return (
    <section aria-labelledby={props.id} className="flex flex-col gap-1.5 pt-4">
      <div className="flex min-w-0 items-center gap-2 text-xs text-fg-3">
        <h3 id={props.id} className="min-w-0 flex-1 truncate">
          {props.title}
        </h3>
        {props.aside}
      </div>
      {props.children}
    </section>
  );
}

export function Loading({ rows = 6 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading" className="px-pane pt-1">
      <SkeletonRows count={rows} widths={[72, 55, 80, 48, 64]} />
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-3 px-4 py-3 text-sm">
      <div>
        <p className="text-fg">Could not read memory</p>
        <p className="mt-0.5 break-words text-fg-2">{message}</p>
      </div>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-4 py-3 text-sm">
      <p className="text-fg">{title}</p>
      {children && <p className="mt-0.5 text-fg-2">{children}</p>}
    </div>
  );
}

/** A detail's title row: the title, a status, and optional actions. */
export function DetailTitle(props: { title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-col gap-1 pt-3">
      <div className="flex min-w-0 items-start gap-2">
        <h2 className="min-w-0 flex-1 text-heading break-words text-fg">{props.title}</h2>
        {props.actions}
      </div>
      {props.children && <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-fg-3">{props.children}</div>}
    </header>
  );
}

/** A row button in a list: 32px, `[slot] label … trailing`; the chosen one carries the `active` fill. */
export function ListRow(props: { selected: boolean; onClick(): void; leading?: ReactNode; label: ReactNode; trailing?: ReactNode; title?: string }) {
  return (
    <li>
      <button
        type="button"
        data-row
        aria-current={props.selected ? "true" : undefined}
        title={props.title}
        onClick={props.onClick}
        className={cn(
          INFO_ROW,
          "h-row-nav w-full text-left press-row focus-inset",
          props.selected ? "bg-active text-fg" : "text-fg-2 hover:bg-hover hover:text-fg",
        )}
      >
        {props.leading && <span className="flex size-4 shrink-0 items-center justify-center">{props.leading}</span>}
        <span className="min-w-0 flex-1 truncate">{props.label}</span>
        {props.trailing && <span className="shrink-0 text-xs text-fg-3">{props.trailing}</span>}
      </button>
    </li>
  );
}
