import "./memory.css";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { errorMessage } from "../../lib/format";
import { Button } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { EmptyState } from "../primitives/EmptyState";
import { Notice } from "../primitives/Notice";

/** A read failure with its next step: "Try again" when the view can retry (rule 20; decision 81: a glyph, not a red sentence). */
export function MemoryError({ message, onRetry }: { message: string; onRetry?: (() => void) | undefined }) {
  return (
    <div className="p-4">
      <Notice
        form="block"
        tone="error"
        title="Could not read memory"
        actions={
          onRetry && (
            <Button size="sm" onClick={onRetry}>
              Try again
            </Button>
          )
        }
      >
        {message}
      </Notice>
    </div>
  );
}

/** The reading width of a detail pane: prose and rows stop growing at 48rem, so a maximised pane does not make 150-character lines. */
export const DETAIL_MAX = "max-w-3xl";

/**
 * Rows with a "⋯" reserve its width at the right (the row's `trailing` slot); rows without actions reserve the same, so
 * the times and sizes of every Memory list end on one edge.
 */
export const ROW_TAIL = <span aria-hidden className="size-6" />;

/**
 * The dim second line of a two-line row: text that gives way (ellipsis) and, at the right, a short tail that never does (a
 * time, a size, "current"). A one-line row puts its date in the row's own `meta` slot instead (same dim small style).
 */
export function RowLine({ children, end }: { children: ReactNode; end?: ReactNode }) {
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {end !== undefined && <span className="shrink-0 tabular-nums">{end}</span>}
    </span>
  );
}

/** An empty view: `EmptyState` centres itself in a flex column that owns the height, which a view's container is not. */
export function PaneEmpty(props: { title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <EmptyState title={props.title} actions={props.actions}>
        {props.children}
      </EmptyState>
    </div>
  );
}

/** The part of a row that opens under it: 32px in, so it lines up with the row's text (inset 8 + glyph 16 + gap 8). */
export function Expansion({ children }: { children: ReactNode }) {
  return (
    <div className="octo-mem-expand">
      <div>
        <div className="@container/ex flex min-w-0 flex-col gap-3 pt-1 pr-2 pb-3 pl-8">{children}</div>
      </div>
    </div>
  );
}

/**
 * Esc on an open row closes it and puts the focus back on the row's own button (decision 93: keyboard throughout). The key
 * is consumed, so the list-detail layout above does not also go back.
 */
export function useCollapseOnEscape(open: boolean, close: () => void) {
  const box = useRef<HTMLLIElement>(null);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !open || e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    close();
    box.current?.querySelector<HTMLElement>("[data-row]")?.focus();
  };
  return { box, onKeyDown };
}

/** Scrolls an item into view once, when it is shown because something else (a search hit) asked for it. */
export function useReveal(box: React.RefObject<HTMLElement | null>, reveal: boolean) {
  useEffect(() => {
    if (reveal) box.current?.scrollIntoView({ block: "center" });
  }, [box, reveal]);
}

/** A forget is always confirmed: nothing here can be brought back. */
export function ConfirmDialog(props: { title: string; description: string; confirm: string; busyText: string; onClose(): void; onConfirm(): Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      title={props.title}
      description={props.description}
      onClose={props.onClose}
      width="sm"
      footer={
        <>
          <Button variant="quiet" onClick={props.onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={busy}
            onClick={() => {
              setBusy(true);
              props.onConfirm().then(props.onClose, (err: unknown) => {
                setError(`${errorMessage(err)} Try again.`);
                setBusy(false);
              });
            }}
          >
            {busy ? props.busyText : props.confirm}
          </Button>
        </>
      }
    >
      {error && <Notice tone="error">{error}</Notice>}
    </Dialog>
  );
}
