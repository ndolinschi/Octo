import { X } from "lucide-react";
import { useRef, type ReactNode } from "react";
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
export function Sheet(props: {
  label: string;
  onClose(): void;
  children: ReactNode;
  variant?: "bottom" | "full";
  /** No header row: the content brings its own (the navigation). */
  bare?: boolean;
  /** Controls at the end of the header, before Close. */
  actions?: ReactNode;
  className?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const state = usePresence();
  useModal(panel, props.onClose);
  useHistoryLayer(state === "open", () => props.onClose());
  const full = props.variant === "full";
  return createPortal(
    <div className="fixed inset-0 z-50" inert={state === "closed"}>
      {!full && <div className="octo-scrim absolute inset-0 bg-scrim" data-state={state} onMouseDown={props.onClose} aria-hidden />}
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={props.label}
        data-state={state}
        data-sheet={full ? "full" : "bottom"}
        className={cn("octo-sheet absolute inset-x-0 flex flex-col overflow-hidden bg-overlay text-fg", props.className)}
      >
        {!props.bare && (
          <header className="flex h-ctl-lg shrink-0 items-center gap-2 pr-2 pl-4">
            <h2 className="min-w-0 flex-1 truncate text-heading">{props.label}</h2>
            {props.actions}
            <IconButton icon={X} label="Close" size="lg" onClick={props.onClose} />
          </header>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{props.children}</div>
      </div>
    </div>,
    document.body,
  );
}
