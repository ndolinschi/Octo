import { X } from "lucide-react";
import { useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { useHistoryLayer } from "../../lib/historyLayer";
import { IconButton } from "./IconButton";
import { usePresence } from "./Presence";
import { useModal } from "./useModal";

/**
 * A sheet of the phone layout (direction 7): rises from the bottom over a scrim (`bottom`, at most 85% of the visible height,
 * above the on-screen keyboard), or covers the whole screen (`full`, the navigation and the panels' lists). Modal like a
 * `Dialog` (focus moves in and back, Esc closes, Tab stays inside) and a history entry: the system Back closes it, and
 * closing it otherwise goes back over its entry (`useHistoryLayer`). A header row (title, Close) unless `bare`. Respects the
 * safe-area insets. Wrap in `<Presence>`.
 *
 * Not for: the desktop layout (menus, popovers and pickers become sheets there through CSS alone, `styles.css` "phone layout").
 */
export type SheetProps = {
  label: string;
  onClose(): void;
  children: ReactNode;
  variant?: "bottom" | "full";
  /** No header row: the content brings its own (the navigation). */
  bare?: boolean;
  /** Controls at the end of the header, before Close. */
  actions?: ReactNode;
  className?: string;
};

/** The sheet's non-portalled DOM structure (exported for unit tests). */
export function SheetFrame({
  label,
  onClose,
  children,
  variant,
  bare,
  actions,
  className,
  state,
  panel,
}: SheetProps & { state: "open" | "closed"; panel?: RefObject<HTMLDivElement | null> }) {
  const full = variant === "full";
  return (
    <div className="fixed inset-0 z-50" inert={state === "closed"}>
      {!full && <div className="octo-scrim absolute inset-0 bg-scrim" data-state={state} onClick={onClose} aria-hidden />}
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        data-state={state}
        data-sheet={full ? "full" : "bottom"}
        className={cn("octo-sheet absolute inset-x-0 flex flex-col overflow-hidden bg-overlay text-fg focus:outline-none", className)}
      >
        {!bare && (
          <header className="flex h-ctl-lg shrink-0 items-center gap-2 pr-2 pl-4">
            <h2 className="min-w-0 flex-1 truncate text-heading">{label}</h2>
            {actions}
            <IconButton icon={X} label="Close" size="lg" onClick={onClose} />
          </header>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
      </div>
    </div>
  );
}

export function Sheet(props: SheetProps) {
  const panel = useRef<HTMLDivElement>(null);
  const state = usePresence();
  useModal(panel, props.onClose);
  useHistoryLayer(state === "open", () => props.onClose());
  return createPortal(<SheetFrame {...props} state={state} panel={panel} />, document.body);
}
